import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROLES = ["scout", "research", "planner", "builder", "reviewer"];
export const TERMINAL = ["succeeded", "rejected", "failed", "blocked", "cancelled", "uncertain"];
export const LIMITS = {
  concurrency: 3,
  startupMs: 30_000,
  taskMs: 1_200_000,
  jobMs: 5_400_000,
  repairs: 2,
  maxTurns: 60,
};
export const MAX_FILE = 16 * 1024 * 1024;
export const MAX_JSON = 1024 * 1024;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const hash = (data) => createHash("sha256").update(data).digest("hex");
export const digest = (value) => hash(JSON.stringify(value));
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function need(condition, message) {
  if (!condition) throw new Error(message);
}
export function text(value, name, max = 64_000) {
  need(
    typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0"),
    `Invalid ${name}`,
  );
  return value;
}
export function id(value) {
  need(typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value), "Invalid task/check ID");
  return value;
}
export function strings(value, name) {
  need(
    Array.isArray(value) && value.every((v) => typeof v === "string" && !v.includes("\0")),
    `Invalid ${name}`,
  );
  return value;
}
export function relative(value) {
  text(value, "relative path");
  need(
    !path.isAbsolute(value) &&
      !value.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git"),
    `Unsafe relative path: ${JSON.stringify(value)}`,
  );
  return value;
}
export function owns(ownership, file) {
  return ownership.some((p) => file === p || file.startsWith(`${p}/`));
}
export function shellQuote(value) {
  text(value, "shell argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function checkedKeys(value, allowed, label) {
  need(value && typeof value === "object" && !Array.isArray(value), `Invalid ${label}`);
  for (const key of Object.keys(value))
    need(allowed.includes(key), `Unknown ${label} field: ${key}`);
}
export async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
export async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  need(!(await fs.lstat(dir)).isSymbolicLink(), "State directory must not be a symlink");
}
export async function readJson(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    need(st.isFile() && st.size <= MAX_JSON, `Invalid/oversized JSON file: ${file}`);
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
export async function atomic(file, value) {
  const encoded = JSON.stringify(value, null, 2) + "\n";
  need(Buffer.byteLength(encoded) <= MAX_JSON, "State exceeds JSON artifact limit");
  await privateDir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(encoded);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
export async function withLock(dir, fn) {
  // ponytail: one coordinator per run; use a transactional store only if multi-controller runs become necessary.
  const file = path.join(dir, "coordinator.lock");
  let handle;
  try {
    handle = await fs.open(file, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST")
      throw new Error(
        "Run is locked; use unlock only after verifying the former coordinator stopped",
      );
    throw e;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.sync();
    return await fn();
  } finally {
    await handle.close();
    await fs.unlink(file);
  }
}
export function environment(config = {}, extra = {}) {
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "PI_CODING_AGENT_DIR",
    "HERDR_SOCKET_PATH",
    "HERDR_SESSION",
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    ...(config.passEnv ?? []),
  ];
  const env = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...extra };
}
export async function command(
  argv,
  { cwd, env = environment(), timeoutMs = 15_000, maxBytes = MAX_FILE, input } = {},
) {
  strings(argv, "command");
  need(argv.length > 0, "Empty command");
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [],
      stderr = [];
    let size = 0,
      failure;
    const timer = setTimeout(() => {
      failure = new Error(`Command deadline exceeded: ${path.basename(argv[0])}`);
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = (target, chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        failure = new Error("Command output exceeded limit");
        child.kill("SIGKILL");
      } else target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export async function git(cwd, args, options = {}) {
  const r = await command(["git", "-C", cwd, "--literal-pathspecs", ...args], options);
  need(r.code === 0, `git ${args[0]} failed (exit ${r.code}); inspect the repository locally`);
  return r.stdout;
}
export function line(value) {
  return value.replace(/\r?\n$/, "");
}
export async function safePath(root, rel) {
  relative(rel);
  let current = root;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    if (await exists(current))
      need(
        !(await fs.lstat(current)).isSymbolicLink(),
        `Symlink not allowed in managed path: ${JSON.stringify(rel)}`,
      );
  }
  return current;
}
export async function fileState(root, rel, blobDir) {
  need(
    !rel
      .split("/")
      .some(
        (p) =>
          p === ".env" || p.startsWith(".env.") || ["auth.json", ".npmrc", ".netrc"].includes(p),
      ),
    "Sensitive file encountered; pinata will not snapshot credentials",
  );
  const file = await safePath(root, rel);
  if (!(await exists(file))) return null;
  const st = await fs.lstat(file);
  need(
    st.isFile() && st.nlink === 1 && st.size <= MAX_FILE,
    `Managed changes must be regular, single-link files <=16MiB: ${JSON.stringify(rel)}`,
  );
  const data = await fs.readFile(file);
  const sha256 = hash(data);
  if (blobDir) {
    await privateDir(blobDir);
    await fs.writeFile(path.join(blobDir, sha256), data, { mode: 0o600 });
  }
  return { sha256, executable: Boolean(st.mode & 0o111) };
}
export async function changedPaths(cwd) {
  const tracked = await git(cwd, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-only",
    "-z",
    "HEAD",
    "--",
  ]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
}
export async function snapshot(cwd, blobDir) {
  const files = Object.create(null);
  for (const file of await changedPaths(cwd)) files[file] = await fileState(cwd, file, blobDir);
  return {
    head: line(await git(cwd, ["rev-parse", "HEAD"])),
    index: hash(
      await git(cwd, [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "HEAD",
        "--",
      ]),
    ),
    files,
  };
}
export async function headState(cwd, rel) {
  relative(rel);
  const listing = await git(cwd, ["ls-tree", "-z", "HEAD", "--", rel]);
  if (!listing) return null;
  const mode = listing.split(" ")[0];
  need(
    mode === "100644" || mode === "100755",
    `Unsupported base file type: ${JSON.stringify(rel)}`,
  );
  // Git output can be binary; obtain it without a text round trip.
  const data = await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "show", `HEAD:${rel}`], {
      env: environment(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (b) => {
      size += b.length;
      if (size <= MAX_FILE) chunks.push(b);
      else child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("Cannot read base blob")),
    );
  });
  return { sha256: hash(data), executable: mode === "100755" };
}
export async function delta(cwd, before, after, blobDir) {
  need(
    before.head === after.head && before.index === after.index,
    "Worker changed HEAD or the index; staging/commits are coordinator-owned actions",
  );
  const changes = [];
  for (const file of [
    ...new Set([...Object.keys(before.files), ...Object.keys(after.files)]),
  ].sort()) {
    const old = Object.hasOwn(before.files, file) ? before.files[file] : await headState(cwd, file);
    const next = await fileState(cwd, file, blobDir);
    if (!equal(old, next)) changes.push({ path: file, before: old, after: next });
  }
  return changes;
}
export async function applyFile(root, change, blobDir) {
  const file = await safePath(root, change.path);
  if (change.after === null) {
    if (await exists(file)) await fs.unlink(file);
    return;
  }
  need(/^[a-f0-9]{64}$/.test(change.after.sha256), "Invalid blob digest");
  const blob = path.join(blobDir, change.after.sha256);
  const blobStat = await fs.lstat(blob);
  need(blobStat.isFile() && blobStat.nlink === 1 && blobStat.size <= MAX_FILE, "Invalid blob file");
  const data = await fs.readFile(blob);
  need(data.length <= MAX_FILE && hash(data) === change.after.sha256, "Blob digest mismatch");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.pinata-${randomUUID()}`);
  let mode = (await exists(file)) ? (await fs.lstat(file)).mode & 0o666 : 0o644;
  if (change.after.executable) mode |= (mode & 0o444) >> 2;
  await fs.writeFile(tmp, data, { mode, flag: "wx" });
  await fs.rename(tmp, file);
}
export function validateChecks(checks) {
  need(Array.isArray(checks), "checks must be an array");
  const names = new Set();
  for (const c of checks) {
    checkedKeys(c, ["id", "argv", "timeoutMs"], "check");
    id(c.id);
    need(!names.has(c.id), "Duplicate check ID");
    names.add(c.id);
    strings(c.argv, "check argv");
    need(c.argv.length > 0 && c.argv[0], "Empty check command");
    need(
      c.timeoutMs === undefined ||
        (Number.isInteger(c.timeoutMs) && c.timeoutMs > 0 && c.timeoutMs <= 1_200_000),
      "Invalid check timeout",
    );
  }
}
export function validateModel(model) {
  checkedKeys(model, ["provider", "id", "thinking"], "model");
  text(model.provider, "provider", 100);
  text(model.id, "model ID", 300);
  need(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(model.thinking),
    "Explicit supported thinking level required",
  );
  return model;
}

export function validateTask(task) {
  checkedKeys(
    task,
    [
      "id",
      "role",
      "task",
      "acceptance",
      "instructions",
      "context",
      "ownership",
      "after",
      "reviewOf",
      "checks",
      "noChecksReason",
      "model",
    ],
    "task",
  );
  id(task.id);
  need(ROLES.includes(task.role), "Unknown persona");
  text(task.task, "task");
  strings(task.acceptance, "acceptance");
  need(task.acceptance.length > 0, "Acceptance criteria required");
  if (task.model !== undefined) validateModel(task.model);
  strings(task.instructions ?? [], "instructions");
  strings(task.context ?? [], "context");
  strings(task.after ?? [], "dependencies").forEach(id);
  strings(task.ownership ?? [], "ownership").forEach(relative);
  validateChecks(task.checks ?? []);
  if (task.role === "builder") {
    need(task.ownership?.length > 0, "Builder ownership required");
    if (!task.checks?.length) text(task.noChecksReason, "noChecksReason");
  } else
    need(
      !task.ownership?.length && !task.checks?.length,
      "Inspection personas cannot own changes or execute checks",
    );
  if (task.role === "reviewer") id(task.reviewOf);
  else need(task.reviewOf === undefined, "Only reviewers use reviewOf");
  return {
    ...task,
    after: task.after ?? [],
    ownership: task.ownership ?? [],
    instructions: task.instructions ?? [],
    context: task.context ?? [],
    checks: task.checks ?? [],
  };
}
export function validateResult(result, spec) {
  checkedKeys(
    result,
    [
      "schemaVersion",
      "runId",
      "taskId",
      "attemptId",
      "taskDigest",
      "status",
      "summary",
      "changedFiles",
      "commit",
      "checks",
      "findings",
      "blockers",
      "brief",
      "sources",
      "review",
    ],
    "result",
  );
  need(
    result.schemaVersion === 1 &&
      result.runId === spec.runId &&
      result.taskId === spec.task.id &&
      result.attemptId === spec.attemptId &&
      result.taskDigest === spec.taskDigest,
    "Result correlation mismatch",
  );
  need(
    ["succeeded", "failed", "blocked", "cancelled"].includes(result.status),
    "Invalid result status",
  );
  text(result.summary, "result summary");
  strings(result.changedFiles, "changedFiles").forEach(relative);
  need(new Set(result.changedFiles).size === result.changedFiles.length, "Duplicate changed files");
  need(result.commit === null, "Workers must report commit:null; commits are not delegated");
  for (const key of ["checks", "findings", "blockers"])
    need(Array.isArray(result[key]), `Missing result ${key}`);
  strings(result.blockers, "blockers");
  for (const c of result.checks) {
    text(c.name, "reported check name");
    need(["passed", "failed", "not-run"].includes(c.status), "Invalid reported check");
    text(c.detail, "reported check detail");
  }
  for (const f of result.findings) {
    need(
      ["critical", "high", "medium", "low", "info"].includes(f.severity),
      "Invalid finding severity",
    );
    text(f.message, "finding");
    text(f.evidence, "finding evidence");
  }
  if (result.status === "succeeded")
    need(result.blockers.length === 0, "Success cannot contain blockers");
  if (spec.task.role !== "builder")
    need(result.changedFiles.length === 0, "Inspection persona claimed changes");
  if (spec.task.role === "research" && result.status === "succeeded") {
    text(result.brief, "research brief", 8000);
    need(Array.isArray(result.sources) && result.sources.length > 0, "Research needs sources");
    for (const source of result.sources) {
      const url = new URL(text(source.url, "source URL"));
      need(
        ["https:", "http:"].includes(url.protocol) && !url.username && !url.password,
        "Invalid source URL",
      );
      text(source.title, "source title");
      text(source.supports, "source claim");
      text(source.applicability, "source applicability");
    }
  }
  if (["scout", "planner"].includes(spec.task.role) && result.status === "succeeded")
    text(result.brief, "brief");
  if (spec.task.role === "reviewer" && result.status === "succeeded") {
    need(
      result.review?.taskId === spec.reviewTarget.taskId &&
        result.review?.fingerprint === spec.reviewTarget.fingerprint,
      "Review target mismatch",
    );
    need(
      ["approve", "changes_requested"].includes(result.review.verdict),
      "Review verdict required",
    );
    if (result.review.verdict === "approve")
      need(
        !result.findings.some((f) => ["critical", "high", "medium"].includes(f.severity)),
        "Approval contains unresolved blocking findings",
      );
  }
  return result;
}

export class JsonEvents {
  constructor() {
    this.buffer = "";
    this.last = null;
    this.settled = false;
    this.started = false;
    this.turns = 0;
    this.retryFailed = false;
    this.sessionId = null;
  }
  push(chunk) {
    this.buffer += chunk;
    need(Buffer.byteLength(this.buffer) <= MAX_FILE, "Oversized JSON event");
    let end;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const raw = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      need(raw.length > 0, "Empty JSON protocol record");
      const event = JSON.parse(raw);
      text(event.type, "event type");
      if (event.type === "session") this.sessionId = event.id;
      if (event.type === "agent_start") {
        this.started = true;
        this.settled = false;
      }
      if (event.type === "turn_end") this.turns++;
      if (event.type === "message_end" && event.message?.role === "assistant")
        this.last = event.message;
      if (event.type === "auto_retry_end") this.retryFailed = event.success === false;
      if (event.type === "agent_settled") this.settled = true;
    }
  }
  result(spec) {
    need(
      this.buffer.length === 0 && this.started && this.settled && this.last,
      "Incomplete Pi JSON run",
    );
    need(
      this.last.stopReason === "stop" && !this.retryFailed,
      `Pi did not succeed (${this.last.stopReason})`,
    );
    need(
      this.last.provider === spec.model.provider && this.last.model === spec.model.id,
      "Pi used an unexpected model",
    );
    const content = this.last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    need(Buffer.byteLength(content) <= MAX_JSON, "Oversized result");
    return validateResult(JSON.parse(content), spec);
  }
}

export async function processTable() {
  const r = await command(["ps", "-axo", "pid=,ppid=,pgid=,lstart=,stat=,comm="], {
    env: environment({}, { LC_ALL: "C" }),
  });
  need(r.code === 0, "Cannot inspect process ownership");
  return r.stdout.split("\n").flatMap((row) => {
    const m = row
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+)$/);
    return m
      ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], started: m[4], state: m[5], name: m[6] }]
      : [];
  });
}
export function sameProcess(a, b) {
  return a.pid === b.pid && a.started === b.started && a.name === b.name && a.pgid === b.pgid;
}
export function descendants(table, pid) {
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of table)
      if (ids.has(p.ppid) && !ids.has(p.pid)) {
        ids.add(p.pid);
        changed = true;
      }
  }
  return table.filter((p) => ids.has(p.pid));
}
export async function living(identities) {
  const table = await processTable();
  return identities.filter((p) => table.some((q) => sameProcess(p, q) && !q.state.startsWith("Z")));
}
export async function terminate(identities) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const p of (await living(identities)).reverse()) {
      need(
        p.pid !== process.pid && p.pid !== process.ppid && p.pid > 1,
        "Refusing unsafe termination",
      );
      try {
        process.kill(p.pid, signal);
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    }
    for (let i = 0; i < 10; i++) {
      if (!(await living(identities)).length) return true;
      await sleep(200);
    }
  }
  return (await living(identities)).length === 0;
}

export async function rpcProbe(pi, cwd, env, requests, extra = [], discover = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pi,
      [
        "--mode",
        "rpc",
        "--offline",
        "--no-session",
        "--no-extensions",
        ...(discover ? [] : ["--no-skills", "--no-prompt-templates"]),
        "--no-context-files",
        "--no-themes",
        "--no-approve",
        ...extra,
      ],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let buffer = "",
      bytes = 0,
      diagnostics = "";
    const responses = new Map();
    let failed;
    const fail = (e) => {
      failed ??= e;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail(new Error("Pi metadata probe timed out")), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_FILE) return fail(new Error("Pi metadata response too large"));
      buffer += chunk;
      try {
        let pos;
        while ((pos = buffer.indexOf("\n")) >= 0) {
          const record = JSON.parse(buffer.slice(0, pos));
          buffer = buffer.slice(pos + 1);
          if (record.type === "response" && requests.some((r) => r.id === record.id)) {
            need(record.success, `Pi metadata command failed: ${record.command}`);
            responses.set(record.id, record.data);
            if (responses.size === requests.length) child.stdin.end();
          }
        }
      } catch (e) {
        fail(e);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
      if (Buffer.byteLength(diagnostics) > MAX_FILE)
        fail(new Error("Pi metadata diagnostics too large"));
    });
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) reject(failed);
      else if (code !== 0 || responses.size !== requests.length)
        reject(new Error("Pi metadata probe failed"));
      else {
        responses.set("resourceWarnings", /collision|duplicate|conflict/i.test(diagnostics));
        resolve(responses);
      }
    });
    for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
  });
}
