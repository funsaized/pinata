#!/usr/bin/env node
// The pinata command line.
//   pinata view [run] [--task <task>]   attach a viewer to a live run, or open a finished one from its log
//   pinata logs [run] [--task <task>] [--follow] [--json]   print a run's log
//   pinata run <job.json> [--no-apply] [--mode observe] [--json] [--watch]
//   pinata integrate <run> [--json]   apply checked changes without starting Pi
//   pinata resume <run>         continue a run that outlived its Pi
// Runs live in <git common dir>/pinata/<run>; a live run has link.json (its socket).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseViewArgs } from "../engine/viewer/arguments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage:
  pinata agents [list|show <name>|validate]   inspect reusable agent definitions
  pinata view [run] [--task <task>]                 attach a viewer to a live run, or replay a finished one
  pinata logs [run] [--task <task>] [--follow] [--json]   print a run's recorded events
  pinata run <job.json> [--no-apply] [--mode observe] [--json] [--watch]   run and deliver a job headless
      exit codes: 0 succeeded, 1 failed, 2 invalid job, 3 cancelled
  pinata resume <run>                      continue a run that outlived its Pi
  pinata integrate <run> [--json]          apply saved isolated snapshots with conflict checks
  pinata migrate <input> [--output <new-file>] convert a legacy job, config or definition
  pinata gc [--confirm]                    preview run cleanup and close finished panes

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
  let cancelled = false;
  const interrupt = () => {
    cancelled = true;
    child.kill("SIGINT");
  };
  const terminate = () => {
    cancelled = true;
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  child.on("exit", (code, signal) => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    process.exit(cancelled || signal ? 3 : (code ?? 1));
  });
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
    } else if (["--json", "--watch", "--no-apply"].includes(arg)) {
      if (flags.has(arg)) fail(`Use ${arg} only once`);
      flags.add(arg);
    } else if (arg.startsWith("-")) fail(`Unknown option ${arg}`);
    else if (job) fail(`Unexpected argument ${arg}`);
    else job = arg;
  }
  if (!job) fail("Usage: pinata run <job.json> [--no-apply] [--mode observe] [--json] [--watch]");
  if (!existsSync(job)) fail(`No job file ${job}`);
  const spec = {
    job: resolve(job),
    ...(mode && { mode }),
    json: flags.has("--json"),
    watch: flags.has("--watch"),
    noApply: flags.has("--no-apply"),
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
  if (command === "migrate") {
    if (!rest[0] || (rest.length !== 1 && (rest.length !== 3 || rest[1] !== "--output")))
      fail("Usage: pinata migrate <input> [--output <new-file>]");
    const { registerHooks, stripTypeScriptTypes } = await import("node:module");
    const engineUrl = new URL("../engine/", import.meta.url).href;
    const hooks = registerHooks({
      load(url, context, nextLoad) {
        if (!url.startsWith(engineUrl) || !url.endsWith(".ts")) return nextLoad(url, context);
        return {
          format: "module",
          source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { sourceUrl: url }),
          shortCircuit: true,
        };
      },
    });
    try {
      const { migrateFile } = await import("../engine/migrate/main.ts");
      for (const notice of await migrateFile(rest[0], rest[2])) writeSync(2, notice + "\n");
    } finally {
      hooks.deregister();
    }
  } else if (command === "view") await view(rest);
  else if (command === "logs") await logs(rest);
  else if (command === "run") run(rest);
  else if (command === "resume") await resume(rest);
  else if (command === "integrate") {
    const args = rest.filter((arg) => arg !== "--json" && arg !== "--recover");
    if (args.length !== 1 || args[0].startsWith("-") || rest.length - args.length > 2)
      fail("Usage: pinata integrate <run> [--json] [--recover]");
    // Node skips native type stripping in node_modules. Load only our engine sources.
    const { registerHooks, stripTypeScriptTypes } = await import("node:module");
    const engineUrl = new URL("../engine/", import.meta.url).href;
    const hooks = registerHooks({
      load(url, context, nextLoad) {
        if (!url.startsWith(engineUrl) || !url.endsWith(".ts")) return nextLoad(url, context);
        return {
          format: "module",
          source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { sourceUrl: url }),
          shortCircuit: true,
        };
      },
    });
    try {
      const { integrateCommand } = await import("../engine/headless/integration.ts");
      process.exitCode = await integrateCommand(args[0], {
        json: rest.includes("--json"),
        recover: rest.includes("--recover"),
        write: (line) => writeSync(1, line + "\n"),
      });
    } finally {
      hooks.deregister();
    }
  } else if (command === "agents") {
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
