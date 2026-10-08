#!/usr/bin/env node
// The pinata command line.
//   pinata view [run] [task]   attach a viewer to a live run of the repository here
// Runs live in <git common dir>/pinata/<run>; a live run has link.json (its socket).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage:
  pinata view [run] [task]   attach a viewer to a live run (run: id prefix or run directory)

Start a run's socket with /pinata watch in Pi, or run in observe mode.`;

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

// Live runs (with link.json), newest first.
function liveRuns(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^[a-f0-9-]{36}$/.test(name) && existsSync(join(root, name, "link.json")))
    .map((name) => ({ dir: join(root, name), at: statSync(join(root, name, "link.json")).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .map((r) => r.dir);
}

function view(args) {
  const cwd = process.cwd();
  let [run, task] = args;
  let runs;
  if (run && existsSync(join(resolve(run), "link.json"))) runs = [resolve(run)];
  else {
    const live = liveRuns(runsRoot(cwd));
    if (run && !/^[a-f0-9-]{1,36}$/.test(run)) {
      // `pinata view <task>`: a task of the newest live run.
      task = run;
      run = undefined;
    }
    runs = run ? live.filter((dir) => dir.split(/[\\/]/).at(-1).startsWith(run)) : live;
    if (!runs.length)
      fail(
        run
          ? `No live run starts with ${run}`
          : "No live pinata run here. In Pi, use /pinata watch (or observe mode).",
      );
    if (run && runs.length > 1) fail(`Run prefix ${run} is ambiguous`);
  }
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
    join(HERE, "..", "engine", "viewer", "main.ts"),
  ];
  const command = node ? process.execPath : pi;
  const windowsShell = process.platform === "win32" && !node && !/\.exe$/i.test(pi);
  const child = spawn(
    windowsShell ? `"${command}"` : command,
    windowsShell ? argv.map((a) => `"${a}"`) : argv,
    {
      stdio: "inherit",
      shell: windowsShell,
      env: { ...process.env, PINATA_VIEW: JSON.stringify({ runs, task, cwd }) },
    },
  );
  child.on("error", (error) => fail(`could not start Pi (${pi}): ${error.message}`));
  child.on("exit", (code) => process.exit(code ?? 0));
}

const [command, ...rest] = process.argv.slice(2);
if (command === "view") view(rest);
else {
  console.log(USAGE);
  process.exit(command && command !== "help" && command !== "--help" ? 1 : 0);
}
