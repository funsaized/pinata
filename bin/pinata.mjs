#!/usr/bin/env node
// The pinata command line.
//   pinata view [run] [task]   attach a viewer to a live run, or open a finished one from its log
//   pinata logs [run] [task] [--follow] [--json]   print a run's log
//   pinata run <job.json> [--mode observe] [--json] [--watch]   run a job headless
//   pinata resume <run>         continue a run that outlived its Pi
// Runs live in <git common dir>/pinata/<run>; a live run has link.json (its socket). Both
// commands run in the pi binary (the viewer interactively, logs in print mode).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage:
  pinata view [run] [task]                 attach a viewer to a live run, or replay a finished one
  pinata logs [run] [task] [--follow] [--json]   print a run's log (the newest run by default)
  pinata run <job.json> [--mode observe] [--json] [--watch]   run a job headless
      exit codes: 0 succeeded, 1 failed, 2 invalid job, 3 cancelled
  pinata resume <run>                      continue a run that outlived its Pi

run: a run id prefix or a run directory. Start a live run's socket with /pinata watch in Pi,
or run in observe mode.`;

function fail(message) {
  console.error(`pinata: ${message}`);
  process.exit(1);
}

function runsRoot(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
  if (r.status !== 0) fail(`${cwd} is not inside a Git repository`);
  const common = r.stdout.trim();
  return join(isAbsolute(common) ? common : resolve(cwd, common), "pinata");
}

// Run directories, newest first; `live` keeps only those with a socket (link.json).
function listRuns(root, live) {
  if (!existsSync(root)) return [];
  const stamp = (dir) => statSync(live ? join(dir, "link.json") : dir).mtimeMs;
  return (
    readdirSync(root)
      .filter((name) => /^[a-f0-9-]{36}$/.test(name))
      .map((name) => join(root, name))
      // Engine runs only: 0.7.0 run directories have no events.jsonl.
      .filter((dir) => existsSync(join(dir, live ? "link.json" : "events.jsonl")))
      .map((dir) => ({ dir, at: stamp(dir) }))
      .sort((a, b) => b.at - a.at)
      .map((r) => r.dir)
  );
}

const isRunId = (arg) => /^[a-f0-9-]{1,36}$/.test(arg);

// Resolves [run] [task] to run directories (newest first) and a task.
function resolveRuns(args, live) {
  let [run, task] = args;
  if (run && existsSync(join(resolve(run), "events.jsonl"))) return { runs: [resolve(run)], task };
  if (run && !isRunId(run)) {
    // `pinata <command> <task>`: a task of the newest run.
    task = run;
    run = undefined;
  }
  const root = runsRoot(process.cwd());
  const all = listRuns(root, live && !run);
  const runs = run ? all.filter((dir) => dir.split(/[\\/]/).at(-1).startsWith(run)) : all;
  if (!runs.length)
    fail(
      run
        ? `No run starts with ${run}`
        : live
          ? "No live pinata run here. In Pi, use /pinata watch (or observe mode)."
          : "No pinata runs here.",
    );
  if (run && runs.length > 1) fail(`Run prefix ${run} is ambiguous`);
  return { runs, task };
}

// Starts the pi binary (PINATA_PI, else pi on PATH) with one pinata extension.
function startPi(extension, piArgs, env, stdin) {
  const pi = process.env.PINATA_PI ?? "pi";
  const node = /\.(c|m)?js$/.test(pi);
  const argv = [
    ...(node ? [pi] : []),
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension",
    join(HERE, "..", "engine", ...extension),
    ...piArgs,
  ];
  const command = node ? process.execPath : pi;
  const windowsShell = process.platform === "win32" && !node && !/\.exe$/i.test(pi);
  const quote = (a) => `"${a.replaceAll('"', '\\"')}"`;
  const child = spawn(
    windowsShell ? quote(command) : command,
    windowsShell ? argv.map(quote) : argv,
    {
      stdio: [stdin, "inherit", "inherit"],
      shell: windowsShell,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...env },
    },
  );
  child.on("error", (error) => fail(`could not start Pi (${pi}): ${error.message}`));
  child.on("exit", (code) => process.exit(code ?? 0));
}

function logs(args) {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const { runs, task } = resolveRuns(
    args.filter((a) => !a.startsWith("--")),
    false,
  );
  const spec = { dir: runs[0], task, follow: flags.has("--follow"), json: flags.has("--json") };
  // Print mode reads stdin until it closes, so stdin is not passed through.
  startPi(["headless", "main.ts"], ["-p", `/pinata-logs ${JSON.stringify(spec)}`], {}, "ignore");
}

function run(args) {
  const job = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--mode");
  if (!job) fail("Usage: pinata run <job.json> [--mode observe] [--json] [--watch]");
  if (!existsSync(job)) fail(`No job file ${job}`);
  const at = args.indexOf("--mode");
  const mode = at === -1 ? undefined : args[at + 1];
  if (mode !== undefined && mode !== "lean" && mode !== "observe")
    fail("--mode is lean or observe");
  const spec = {
    job: resolve(job),
    ...(mode && { mode }),
    json: args.includes("--json"),
    watch: args.includes("--watch"),
  };
  startPi(["headless", "main.ts"], ["-p", `/pinata-run ${JSON.stringify(spec)}`], {}, "ignore");
}

function resume(args) {
  const { runs } = resolveRuns(args.slice(0, 1), false);
  startPi(
    ["headless", "main.ts"],
    ["-p", `/pinata-resume ${JSON.stringify({ dir: runs[0] })}`],
    {},
    "ignore",
  );
}

function view(args) {
  // A live run first; a run given by id may also be a finished one (replayed from its log).
  const { runs, task } = resolveRuns(args, true);
  startPi(
    ["viewer", "main.ts"],
    [],
    { PINATA_VIEW: JSON.stringify({ runs, task, cwd: process.cwd() }) },
    "inherit",
  );
}

const [command, ...rest] = process.argv.slice(2);
if (command === "view") view(rest);
else if (command === "logs") logs(rest);
else if (command === "run") run(rest);
else if (command === "resume") resume(rest);
else {
  console.log(USAGE);
  process.exit(command && command !== "help" && command !== "--help" ? 1 : 0);
}
