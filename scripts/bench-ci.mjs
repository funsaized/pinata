// Capture diagnostics and every batch file even when benchmark imports fail.
// Usage: node scripts/bench-ci.mjs <label> <node arguments...>
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [label, ...args] = process.argv.slice(2);
if (!label || !/^[a-z0-9-]+$/.test(label) || !args.length)
  throw new Error("Usage: node scripts/bench-ci.mjs <lowercase-label> <node arguments...>");
if (args.some((value) => value === "--out" || value.startsWith("--out=")))
  throw new Error("The CI wrapper owns --out; select measurement storage with PINATA_BENCH_ROOT");

const startedAt = new Date().toISOString();
const id = `${label}-${startedAt.replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
const directory = resolve("bench/results");
await mkdir(directory, { recursive: true });
const logPath = join(directory, `${id}.log`);
const statusPath = join(directory, `${id}.status.json`);
const mappingPath = join(directory, `${id}.paths.json`);
const retainedDirectory = join(directory, `${id}.batch`);
const measurementRoot = resolve(process.env.PINATA_BENCH_ROOT ?? tmpdir());
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
  requestedCommand: [process.execPath, ...args],
  measurementRoot,
  retainedDirectory,
  state: "allocated",
};
async function saveStatus() {
  const data = JSON.stringify(status, null, 2) + "\n";
  await statusFile.write(data, 0, "utf8");
  await statusFile.truncate(Buffer.byteLength(data));
  await statusFile.sync();
}
let measurementDirectory;
let child;
let interruptedSignal;
let outcome = { code: null, signal: null };
let executionError;
let logError;
let archiveError;
let writes = Promise.resolve();
const forwardSignal = (signal) => {
  interruptedSignal ??= signal;
  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
};
const interrupt = () => forwardSignal("SIGINT");
const terminate = () => forwardSignal("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  await saveStatus();
  await mkdir(measurementRoot, { recursive: true });
  measurementDirectory = await realpath(await mkdtemp(join(measurementRoot, `pinata-ci-${id}-`)));
  const command = [...args, "--out", join(measurementDirectory, "report.json")];
  Object.assign(status, {
    state: "running",
    measurementDirectory,
    command: [process.execPath, ...command],
  });
  await saveStatus();
  if (interruptedSignal)
    throw new Error(`Benchmark interrupted before launch: ${interruptedSignal}`);
  child = spawn(process.execPath, command, { stdio: ["ignore", "pipe", "pipe"] });
  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ])
    stream.on("data", (chunk) => {
      target.write(chunk);
      writes = writes.then(() => log.write(chunk)).then(() => undefined);
      writes.catch(() => {});
    });
  child.once("error", (error) => (executionError = error.message));
  outcome = await new Promise((done) =>
    child.once("close", (code, signal) => done({ code, signal })),
  );
} catch (error) {
  executionError = error instanceof Error ? error.message : String(error);
} finally {
  try {
    await writes;
    await log.sync();
  } catch (error) {
    logError = error instanceof Error ? error.message : String(error);
  }
  await log.close();
  if (measurementDirectory) {
    try {
      // Copy the whole batch, including failed/pending cells and hidden files.
      // Keep the source in place; original absolute paths remain evidence.
      await cp(measurementDirectory, retainedDirectory, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      await writeFile(
        mappingPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            originalDirectory: measurementDirectory,
            retainedDirectory,
            originalReport: join(measurementDirectory, "report.json"),
            retainedReport: join(retainedDirectory, "report.json"),
            originalCells: join(measurementDirectory, "report.json.cells"),
            retainedCells: join(retainedDirectory, "report.json.cells"),
            sourceRetained: true,
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
      process.stdout.write(`Retained benchmark batch: ${retainedDirectory}\n`);
    } catch (error) {
      archiveError = error instanceof Error ? error.message : String(error);
    }
  }
  Object.assign(status, {
    state: "finished",
    finishedAt: new Date().toISOString(),
    ...outcome,
    ...(executionError && { error: executionError }),
    ...(logError && { logError }),
    ...(archiveError && { archiveError }),
    ...(interruptedSignal && { interruptedSignal }),
    retention: measurementDirectory ? (archiveError ? "failed" : "copied") : "not_allocated",
  });
  await saveStatus();
  await statusFile.close();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
const failed =
  outcome.code !== 0 || executionError || logError || archiveError || interruptedSignal;
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `\n### Benchmark ${label}: ${failed ? "failed" : "passed"}\n\n` +
      `Exit: ${outcome.code ?? "none"}; signal: ${outcome.signal ?? "none"}. ` +
      `Console, command status and complete batch evidence are retained in the benchmark artifact (\`${id}\`).\n`,
  );
if (interruptedSignal) process.kill(process.pid, interruptedSignal);
else process.exitCode = failed ? outcome.code || 1 : 0;
