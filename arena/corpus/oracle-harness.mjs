import { spawn } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { deserialize, serialize } from "node:v8";

const workerFile = fileURLToPath(new URL("./candidate-worker.mjs", import.meta.url));
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_CHANNEL_BYTES = 8 * MAX_FRAME_BYTES;
const MAX_LOG_BYTES = 64 * 1024;
const errorTypes = {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  URIError,
  EvalError,
};

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

// Node's permission model follows symlinks, so never admit them into the read root.
// These checks and permission flags are defense in depth, not an OS sandbox.
async function candidateRoot(candidateDir) {
  if (typeof candidateDir !== "string" || candidateDir.length === 0) {
    throw new Error("Usage: node oracle.mjs <candidateDir>");
  }
  if ((await lstat(candidateDir)).isSymbolicLink()) {
    throw new Error("Candidate root is a symbolic link");
  }
  const root = await realpath(candidateDir);
  if (root.includes("*")) throw new Error("Candidate path contains a permission wildcard");
  if (!(await lstat(root)).isDirectory()) throw new Error("Candidate must be a directory");
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 10_000) throw new Error("Candidate tree is too large");
      if (entry.isSymbolicLink()) throw new Error("Candidate contains a symbolic link");
      if (entry.isDirectory()) pending.push(resolve(directory, entry.name));
      else if (!entry.isFile()) throw new Error("Candidate contains a special file");
    }
  }
  return root;
}

// Serializing arguments and result together preserves graph identity. Restore
// shared nodes to parent inputs so existing assert.notEqual checks still work.
function restoreInputAliases(originalArgs, remoteArgs, value) {
  if (!isDeepStrictEqual(originalArgs, remoteArgs))
    throw new Error("Candidate changed its arguments");
  const originals = new Map();
  const copies = new Map();
  const pair = (original, remote) => {
    if (original === null || typeof original !== "object") return;
    if (originals.has(remote)) {
      if (originals.get(remote) !== original) throw new Error("Invalid argument alias graph");
      return;
    }
    if (copies.has(original)) throw new Error("Invalid argument alias graph");
    originals.set(remote, original);
    copies.set(original, remote);
    if (original instanceof Map) {
      const remoteEntries = [...remote.entries()];
      [...original.entries()].forEach(([key, item], index) => {
        pair(key, remoteEntries[index][0]);
        pair(item, remoteEntries[index][1]);
      });
    } else if (original instanceof Set) {
      const remoteEntries = [...remote];
      [...original].forEach((item, index) => pair(item, remoteEntries[index]));
    } else {
      for (const key of Object.keys(original)) pair(original[key], remote[key]);
    }
  };
  pair(originalArgs, remoteArgs);
  const visited = new Set();
  const restore = (item) => {
    if (item === null || typeof item !== "object") return item;
    if (originals.has(item)) return originals.get(item);
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
    } else {
      for (const key of Object.keys(item)) {
        Object.defineProperty(item, key, {
          value: restore(item[key]),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return item;
  };
  return restore(value);
}

function startWorker(root, names) {
  const outerBudget = Number(process.env.ARENA_ORACLE_TIMEOUT_MS ?? 10_000);
  const budget = Math.max(
    1,
    Math.floor((Number.isFinite(outerBudget) ? outerBudget : 10_000) * 0.8),
  );
  const requestBudget = Math.min(2000, budget);
  const env = {};
  for (const key of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TZ"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${root}`,
      `--allow-fs-read=${workerFile}`,
      workerFile,
      root,
      JSON.stringify(names),
    ],
    {
      cwd: root,
      env,
      // Fresh pipes: the parent's score fd 3 is NEVER inherited. No detached group,
      // so the outer runner's group cleanup also reaches candidate descendants.
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  const input = child.stdio[3];
  const output = child.stdio[4];
  let state = "loading";
  let fatal;
  let nextId = 0;
  let receivedBytes = 0;
  let logBytes = 0;
  let buffered = Buffer.alloc(0);
  let shutdownId;
  const pending = new Map();
  let resolveReady;
  let rejectReady;
  let resolveClosed;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const closed = new Promise((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  const fail = (reason) => {
    if (fatal) return;
    fatal = reason instanceof Error ? reason : new Error(String(reason));
    rejectReady(fatal);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(fatal);
    }
    pending.clear();
    child.kill("SIGKILL");
    input.destroy();
    output.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const deadline = setTimeout(
    () => fail(new Error("Candidate worker exceeded total time budget")),
    budget,
  );
  const initialization = setTimeout(
    () => fail(new Error("Candidate worker did not become ready")),
    requestBudget,
  );
  const send = (message) => {
    const payload = serialize(message);
    if (payload.length > MAX_FRAME_BYTES) throw new Error("Candidate request is too large");
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    input.write(frame, (error) => {
      if (error) fail(new Error(`Candidate request channel failed: ${error.message}`));
    });
  };
  const receive = (message) => {
    if (message?.protocolVersion !== 1) throw new Error("Invalid candidate protocol version");
    if (state === "loading") {
      if (!exactKeys(message, ["protocolVersion", "type"]) || message.type !== "ready") {
        throw new Error("Candidate sent a message before ready");
      }
      state = "ready";
      clearTimeout(initialization);
      resolveReady();
      return;
    }
    if (state === "closing") {
      if (
        !exactKeys(message, ["protocolVersion", "type", "id"]) ||
        message.type !== "done" ||
        message.id !== shutdownId
      ) {
        throw new Error("Invalid candidate shutdown response");
      }
      state = "done";
      return;
    }
    if (state !== "ready" || message.type !== "result" || !Number.isSafeInteger(message.id)) {
      throw new Error("Unsolicited candidate response");
    }
    const request = pending.get(message.id);
    if (!request) throw new Error("Unknown or duplicate candidate response id");
    if (message.ok === true) {
      if (!exactKeys(message, ["protocolVersion", "type", "id", "ok", "args", "value"])) {
        throw new Error("Malformed candidate result");
      }
      const value = restoreInputAliases(request.args, message.args, message.value);
      pending.delete(message.id);
      clearTimeout(request.timer);
      request.resolve(value);
    } else if (message.ok === false) {
      if (
        !exactKeys(message, ["protocolVersion", "type", "id", "ok", "error"]) ||
        !exactKeys(message.error, ["name", "message"]) ||
        typeof message.error.name !== "string" ||
        typeof message.error.message !== "string" ||
        message.error.message.length > 1200
      )
        throw new Error("Malformed candidate error");
      const ErrorType = Object.hasOwn(errorTypes, message.error.name)
        ? errorTypes[message.error.name]
        : Error;
      pending.delete(message.id);
      clearTimeout(request.timer);
      request.reject(new ErrorType(message.error.message));
    } else throw new Error("Malformed candidate result status");
  };
  output.on("data", (chunk) => {
    if (fatal) return;
    try {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_CHANNEL_BYTES)
        throw new Error("Candidate RPC output exceeded byte limit");
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const size = buffered.readUInt32BE(0);
        if (size === 0 || size > MAX_FRAME_BYTES) throw new Error("Invalid candidate frame length");
        if (buffered.length < size + 4) break;
        const payload = buffered.subarray(4, size + 4);
        buffered = buffered.subarray(size + 4);
        receive(deserialize(payload));
      }
    } catch (error) {
      fail(error);
    }
  });
  output.on("error", (error) =>
    fail(new Error(`Candidate response channel failed: ${error.message}`)),
  );
  input.on("error", (error) =>
    fail(new Error(`Candidate request channel failed: ${error.message}`)),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      if (fatal) return;
      const remaining = Math.max(0, MAX_LOG_BYTES - logBytes);
      if (remaining) process.stderr.write(chunk.subarray(0, remaining));
      logBytes += chunk.length;
      if (logBytes > MAX_LOG_BYTES) fail(new Error("Candidate stdout/stderr exceeded byte limit"));
    });
    stream.on("error", fail);
  }
  child.on("error", fail);
  // 'exit' can precede the last pipe data event. Validate only after all pipes
  // close, so a valid final frame cannot race the process exit notification.
  child.on("close", (code, signal) => {
    if (state !== "done" || code !== 0 || signal || pending.size || buffered.length) {
      fail(
        new Error(`Candidate exited before completing protocol (code=${code}, signal=${signal})`),
      );
    }
    resolveClosed();
  });
  const call = async (module, method, args) => {
    await ready;
    if (fatal) throw fatal;
    if (state !== "ready") throw new Error("Candidate worker is not accepting calls");
    return new Promise((resolveCall, rejectCall) => {
      const id = nextId++;
      const timer = setTimeout(
        () => fail(new Error(`Candidate request ${id} timed out`)),
        requestBudget,
      );
      pending.set(id, { args, resolve: resolveCall, reject: rejectCall, timer });
      try {
        send({ protocolVersion: 1, type: "call", id, module, method, args });
      } catch (error) {
        fail(error);
      }
    });
  };
  const modules = Object.fromEntries(
    names.map((name) => [
      name,
      new Proxy(Object.create(null), {
        get: (_target, method) => {
          if (method === "then" || typeof method !== "string") return undefined;
          return (...args) => call(name, method, args);
        },
      }),
    ]),
  );
  return {
    modules,
    ready,
    get error() {
      return fatal;
    },
    async finish() {
      if (!fatal) {
        if (pending.size) fail(new Error("Oracle left candidate requests unfinished"));
        else {
          state = "closing";
          shutdownId = nextId++;
          try {
            send({ protocolVersion: 1, type: "shutdown", id: shutdownId });
          } catch (error) {
            fail(error);
          }
        }
      }
      await closed;
      if (fatal) throw fatal;
    },
    dispose() {
      clearTimeout(deadline);
      clearTimeout(initialization);
      for (const request of pending.values()) clearTimeout(request.timer);
      child.kill("SIGKILL");
      input.destroy();
      output.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

export function emitOracleResult(result) {
  writeSync(process.env.ARENA_SCORE_FD === "3" ? 3 : 1, `${JSON.stringify(result)}\n`);
  process.exitCode = result.failed.length === 0 ? 0 : 1;
}

// Trusted assertions and scoring live only here. Candidate code is imported in
// the restricted child. This is not an OS sandbox: Node permissions have limits,
// including network and already-open descriptors; container/UID isolation remains
// necessary for hostile submissions.
export async function runOracle(candidateDir, names, cases) {
  let worker;
  let loadError;
  const outcomes = [];
  try {
    const root = await candidateRoot(candidateDir);
    if (!Array.isArray(names) || names.some((name) => !/^[a-z][a-z0-9-]*$/i.test(name))) {
      throw new Error("Invalid oracle module names");
    }
    worker = startWorker(root, names);
    await worker.ready;
  } catch (error) {
    loadError = error;
  }
  try {
    for (const [id, [name, check]] of cases.entries()) {
      try {
        if (loadError) throw loadError;
        if (worker.error) throw worker.error;
        await check(worker.modules);
        outcomes.push({ id, passed: true });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        outcomes.push({ id, passed: false, error: `${name}: ${detail.slice(0, 1200)}` });
      }
    }
    if (worker) {
      try {
        await worker.finish();
      } catch (error) {
        loadError = error;
      }
    }
    // A malformed or incomplete channel invalidates ALL observations, including
    // duplicate messages arriving after the final assertion completed.
    if (loadError) {
      const detail = loadError instanceof Error ? loadError.message : String(loadError);
      for (const outcome of outcomes) {
        outcome.passed = false;
        outcome.error = `${cases[outcome.id][0]}: ${detail.slice(0, 1200)}`;
      }
    }
  } finally {
    worker?.dispose();
  }
  const failed = outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.error);
  const result = {
    schemaVersion: 1,
    passed: outcomes.length - failed.length,
    total: outcomes.length,
    failed,
    cases: outcomes,
  };
  emitOracleResult(result);
  return result;
}
