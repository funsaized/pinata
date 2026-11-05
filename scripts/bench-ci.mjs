// Capture diagnostics even when a benchmark fails before it can create its report.
// Usage: node scripts/bench-ci.mjs <label> <node arguments...>
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [label, ...args] = process.argv.slice(2);
if (!label || !/^[a-z0-9-]+$/.test(label) || !args.length)
  throw new Error("Usage: node scripts/bench-ci.mjs <lowercase-label> <node arguments...>");

const startedAt = new Date().toISOString();
const id = `${label}-${startedAt.replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
const directory = resolve("bench/results");
await mkdir(directory, { recursive: true });
const logPath = join(directory, `${id}.log`);
const statusPath = join(directory, `${id}.status.json`);
const log = await open(logPath, "wx");
const statusFile = await open(statusPath, "wx");
const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000 });
const status = {
  schemaVersion: 1,
  label,
  startedAt,
  commit: git.status === 0 ? git.stdout.trim() : null,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  command: [process.execPath, ...args],
  state: "running",
};
async function saveStatus() {
  const data = JSON.stringify(status, null, 2) + "\n";
  await statusFile.write(data, 0, "utf8");
  await statusFile.truncate(Buffer.byteLength(data));
  await statusFile.sync();
}
await saveStatus();

let writes = Promise.resolve();
const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
for (const [stream, target] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
])
  stream.on("data", (chunk) => {
    target.write(chunk);
    writes = writes.then(() => log.write(chunk)).then(() => undefined);
    // Keep a failed write observed while the child is still running.
    writes.catch(() => {});
  });
let spawnError;
child.once("error", (error) => (spawnError = error.message));
const outcome = await new Promise((resolve) =>
  child.once("close", (code, signal) => resolve({ code, signal })),
);
let logError;
try {
  await writes;
  await log.sync();
} catch (error) {
  logError = error.message;
}
await log.close();
Object.assign(status, {
  state: "finished",
  finishedAt: new Date().toISOString(),
  ...outcome,
  ...(spawnError && { error: spawnError }),
  ...(logError && { logError }),
});
await saveStatus();
await statusFile.close();
const failed = outcome.code !== 0 || spawnError || logError;
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `\n### Benchmark ${label}: ${failed ? "failed" : "passed"}\n\n` +
      `Exit: ${outcome.code ?? "none"}; signal: ${outcome.signal ?? "none"}. ` +
      `Console and command status are retained in the benchmark artifact (\`${id}\`).\n`,
  );
process.exitCode = failed ? outcome.code || 1 : 0;
