import { fork } from "node:child_process";
import { writeSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

function restoreAliases(original, remote, value) {
  if (!isDeepStrictEqual(original, remote)) throw new Error("Candidate mutated input arguments");
  const aliases = new Map();
  const pair = (left, right) => {
    if (!left || typeof left !== "object" || aliases.has(right)) return;
    aliases.set(right, left);
    if (left instanceof Map)
      [...left].forEach(([key, item], index) => {
        pair(key, [...right][index][0]);
        pair(item, [...right][index][1]);
      });
    else if (left instanceof Set) [...left].forEach((item, index) => pair(item, [...right][index]));
    else for (const key of Object.keys(left)) pair(left[key], right[key]);
  };
  pair(original, remote);
  const visited = new Set();
  const restore = (item) => {
    if (!item || typeof item !== "object") return item;
    if (aliases.has(item)) return aliases.get(item);
    if (visited.has(item)) return item;
    visited.add(item);
    if (item instanceof Map) {
      const entries = [...item];
      item.clear();
      for (const [key, entry] of entries) item.set(restore(key), restore(entry));
    } else if (item instanceof Set) {
      const entries = [...item];
      item.clear();
      for (const entry of entries) item.add(restore(entry));
    } else
      for (const key of Object.keys(item))
        Object.defineProperty(item, key, {
          value: restore(item[key]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
    return item;
  };
  return restore(value);
}
async function validateTree(directory) {
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Candidate contains a symbolic link");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await validateTree(join(directory, entry.name));
    else if (!entry.isFile()) throw new Error("Candidate contains a link or special file");
  }
}

export async function runOracle(candidateDirectory, names, cases, options = {}) {
  const outcomes = [];
  let child;
  let fatal;
  let phase = "loading";
  let ordinal = 0;
  let pending;
  let readyResolve;
  let readyReject;
  let closedResolve;
  const closed = new Promise((accept) => {
    closedResolve = accept;
  });
  const ready = new Promise((accept, reject) => {
    readyResolve = accept;
    readyReject = reject;
  });
  ready.catch(() => {});
  const fail = (error) => {
    fatal ??= error instanceof Error ? error : new Error(String(error));
    readyReject(fatal);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(fatal);
      pending = undefined;
    }
    child?.kill("SIGKILL");
  };
  const budget = Math.max(1, Number(process.env.ARENA_ORACLE_TIMEOUT_MS ?? 10000) * 0.8);
  const timer = setTimeout(() => fail(new Error("Oracle candidate deadline exceeded")), budget);
  try {
    await validateTree(candidateDirectory);
    const root = await realpath(candidateDirectory);
    if (root.includes("*") || names.some((name) => !/^[a-z][a-z0-9-]*$/i.test(name)))
      throw new Error("Invalid candidate root or module name");
    const worker = fileURLToPath(new URL("./candidate-worker.mjs", import.meta.url));
    const env = Object.fromEntries(
      ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TZ"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    );
    child = fork(worker, [root, JSON.stringify(names)], {
      cwd: root,
      env,
      serialization: "advanced",
      execArgv: [
        "--permission",
        `--allow-fs-read=${root}`,
        `--allow-fs-read=${worker}`,
        ...(options.network && process.allowedNodeEnvironmentFlags.has("--allow-net")
          ? ["--allow-net"]
          : []),
      ],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let logBytes = 0;
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (bytes) => {
        logBytes += bytes.length;
        if (logBytes > 65536) fail(new Error("Candidate output exceeded oracle allowance"));
        else process.stderr.write(bytes);
      });
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      if (phase !== "closed" || code !== 0 || signal)
        fail(new Error(`Candidate protocol incomplete: ${code}/${signal}`));
    });
    child.on("close", closedResolve);
    child.on("message", (message) => {
      try {
        if (phase === "loading" && message?.kind === "ready" && Object.keys(message).length === 1) {
          phase = "ready";
          readyResolve();
          return;
        }
        if (!pending || message?.id !== pending.id)
          throw new Error("Unsolicited or duplicate candidate response");
        const request = pending;
        let value;
        if (message.kind === "closed" && phase === "closing" && Object.keys(message).length === 2)
          phase = "closed";
        else if (
          message.kind === "result" &&
          phase === "ready" &&
          Object.keys(message).sort().join() === "args,id,kind,value"
        )
          value = restoreAliases(request.args, message.args, message.value);
        else if (
          message.kind === "error" &&
          phase === "ready" &&
          Object.keys(message).sort().join() === "id,kind,message,name" &&
          typeof message.message === "string" &&
          message.message.length <= 1200
        ) {
          const types = {
            Error,
            TypeError,
            RangeError,
            SyntaxError,
            ReferenceError,
            URIError,
            EvalError,
          };
          const Type = Object.hasOwn(types, message.name) ? types[message.name] : Error;
          pending = undefined;
          clearTimeout(request.timer);
          request.reject(new Type(message.message));
          return;
        } else throw new Error("Malformed candidate response");
        pending = undefined;
        clearTimeout(request.timer);
        request.resolve(value);
      } catch (error) {
        fail(error);
      }
    });
    await ready;
  } catch (error) {
    fail(error);
  }
  const request = (message) =>
    new Promise((resolve, reject) => {
      if (fatal) {
        reject(fatal);
        return;
      }
      if (pending) {
        reject(new Error("Concurrent candidate request"));
        return;
      }
      const id = ++ordinal;
      pending = {
        id,
        args: message.args,
        resolve,
        reject,
        timer: setTimeout(
          () => fail(new Error("Candidate call timed out")),
          Math.min(5000, budget),
        ),
      };
      child.send({ ...message, id }, (error) => {
        if (error) fail(error);
      });
    });
  const modules = Object.fromEntries(
    names.map((module) => [
      module,
      new Proxy(Object.create(null), {
        get: (_target, method) =>
          typeof method === "string" && method !== "then"
            ? (...args) => request({ kind: "call", module, method, args })
            : undefined,
      }),
    ]),
  );
  try {
    for (const [id, [name, check]] of cases.entries()) {
      try {
        if (fatal) throw fatal;
        await check(modules);
        outcomes.push({ id, passed: true });
      } catch (error) {
        outcomes.push({
          id,
          passed: false,
          error: `${name}: ${String(error?.message ?? error).slice(0, 1200)}`,
        });
      }
    }
    if (child && !fatal) {
      phase = "closing";
      await request({ kind: "close" });
      await closed;
    }
  } catch (error) {
    fail(error);
  } finally {
    clearTimeout(timer);
    child?.kill("SIGKILL");
  }
  if (fatal)
    for (const outcome of outcomes) {
      outcome.passed = false;
      outcome.error = String(fatal.message).slice(0, 1200);
    }
  const failed = outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.error);
  const result = {
    schemaVersion: 1,
    passed: outcomes.length - failed.length,
    total: outcomes.length,
    failed,
    cases: outcomes,
  };
  // Only this trusted parent owns stdout. Candidate stdout is a separate pipe.
  writeSync(process.env.ARENA_SCORE_FD === "3" ? 3 : 1, `${JSON.stringify(result)}\n`);
  process.exitCode = failed.length ? 1 : 0;
  return result;
}
