#!/usr/bin/env node
// The pinata command line.
//   pinata view [run] [--task <task>]   attach a viewer to a live run, or open a finished one from its log
//   pinata logs [run] [--task <task>] [--follow] [--json]   print a run's log
//   pinata run <job.json> [--mode observe] [--json] [--watch]   run a job headless
//   pinata resume <run>         continue a run that outlived its Pi
// Runs live in <git common dir>/pinata/<run>; a live run has link.json (its socket). Both
// commands run in the pi binary (the viewer interactively, logs in print mode).
import { spawn } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseViewArgs } from "../engine/viewer/arguments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage:
  pinata agents [list|show <name>|validate]   inspect reusable agent definitions
  pinata view [run] [--task <task>]                 attach a viewer to a live run, or replay a finished one
  pinata logs [run] [--task <task>] [--follow] [--json]   print a run's recorded events
  pinata run <job.json> [--mode observe] [--json] [--watch]   run a job headless
      exit codes: 0 succeeded, 1 failed, 2 invalid job, 3 cancelled
  pinata resume <run>                      continue a run that outlived its Pi
  pinata gc [--confirm]                    retire 0.7.0 runs (preview by default) and settled panes

run: a run id prefix or a run directory. view prefers active work, then the latest saved run;
with no runs it waits for one. --task selects a conversation and pins its run.
In Pi, /pinata view --external enables streaming and steering from another terminal.
Without a connection, view follows recorded output read-only.`;

function fail(message) {
  writeSync(2, `pinata: ${message}\n`);
  process.exit(1);
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

async function logs(args) {
  const flags = new Set();
  const targetArgs = args.filter((arg, i) => {
    if (args[i - 1] === "--task") return true;
    if (!["--follow", "--json"].includes(arg)) return true;
    if (flags.has(arg)) fail(`Use ${arg} only once`);
    flags.add(arg);
    return false;
  });
  const spec = {
    ...parseViewArgs(targetArgs),
    cwd: process.cwd(),
    follow: flags.has("--follow"),
    json: flags.has("--json"),
  };
  startPi(["headless", "main.ts"], ["-p", `/pinata-logs ${JSON.stringify(spec)}`], {}, "ignore");
}

function run(args) {
  let job, mode;
  const flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode") {
      if (mode !== undefined) fail("Use --mode only once");
      mode = args[++i];
      if (mode !== "lean" && mode !== "observe") fail("--mode is lean or observe");
    } else if (["--json", "--watch"].includes(arg)) {
      if (flags.has(arg)) fail(`Use ${arg} only once`);
      flags.add(arg);
    } else if (arg.startsWith("-")) fail(`Unknown option ${arg}`);
    else if (job) fail(`Unexpected argument ${arg}`);
    else job = arg;
  }
  if (!job) fail("Usage: pinata run <job.json> [--mode observe] [--json] [--watch]");
  if (!existsSync(job)) fail(`No job file ${job}`);
  const spec = {
    job: resolve(job),
    ...(mode && { mode }),
    json: flags.has("--json"),
    watch: flags.has("--watch"),
  };
  startPi(["headless", "main.ts"], ["-p", `/pinata-run ${JSON.stringify(spec)}`], {}, "ignore");
}

async function resume(args) {
  if (args.length !== 1 || args[0].startsWith("-")) fail("Usage: pinata resume <run>");
  startPi(
    ["headless", "main.ts"],
    ["-p", `/pinata-resume ${JSON.stringify({ run: args[0], cwd: process.cwd() })}`],
    {},
    "ignore",
  );
}

async function view(args) {
  const spec = { ...parseViewArgs(args), cwd: process.cwd() };
  startPi(["viewer", "main.ts"], [], { PINATA_VIEW: JSON.stringify(spec) }, "inherit");
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "view") await view(rest);
  else if (command === "logs") await logs(rest);
  else if (command === "run") run(rest);
  else if (command === "resume") await resume(rest);
  else if (command === "agents") {
    const action = rest[0] ?? "list";
    if (
      !["list", "show", "validate"].includes(action) ||
      (action === "show" && !rest[1]) ||
      rest.length > (action === "show" ? 2 : 1)
    )
      fail("Usage: pinata agents [list|show <name>|validate]");
    startPi(
      ["headless", "main.ts"],
      ["-p", `/pinata-agents ${JSON.stringify({ action, name: rest[1] })}`],
      {},
      "ignore",
    );
  } else if (command === "gc") {
    if (rest.length > 1 || (rest[0] && rest[0] !== "--confirm"))
      fail("Usage: pinata gc [--confirm]");
    startPi(
      ["headless", "main.ts"],
      ["-p", `/pinata-gc ${JSON.stringify({ confirm: rest.includes("--confirm") })}`],
      {},
      "ignore",
    );
  } else {
    writeSync(1, USAGE + "\n");
    process.exit(command && command !== "help" && command !== "--help" ? 1 : 0);
  }
} catch (error) {
  fail(error.message);
}
