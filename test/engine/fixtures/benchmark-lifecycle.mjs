// Real subprocess fixtures: the coordinator must exit naturally after its trial,
// even when a detached process keeps a host/cleanup utility's output pipes open.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main, runTrial } from "../../../bench/process.ts";
import { runCleanupCommand } from "../../../bench/process-tree.ts";
import { fanout } from "../../../bench/scenarios/fanout.ts";

const [mode, directory] = process.argv.slice(2);
const pidsFile = join(directory, "pids.json");
const reportPath = join(directory, "trial.json");

if (mode === "collector-exit") {
  await main(
    ["--repeat", "3", "--scenario", "fanout-1", "--out", join(directory, "aggregate.json")],
    async () => process.exit(7),
  );
} else if (mode === "cleanup-command-abort") {
  const controller = new AbortController();
  const running = runCleanupCommand(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: ['ignore', 1, 2] });
    writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([process.pid, nested.pid]));
    nested.unref();
    process.exit(0);
  `,
    ],
    controller.signal,
  );
  running.catch(() => {});
  while (!(await readFile(pidsFile, "utf8").catch(() => ""))) {
    await new Promise((done) => setTimeout(done, 10));
  }
  controller.abort(new Error("fixture cleanup aborted"));
  try {
    await running;
  } catch (error) {
    console.log(JSON.stringify({ error: String(error) }));
  }
} else {
  const host = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: ['ignore', 1, 2] });
    writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([process.pid, nested.pid]));
    nested.unref();
    process.stdout.write('ready\\n');
    process.stdin.on('data', () => process.exit(0));
    setInterval(() => {}, 1000);
  `,
    ],
    { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] },
  );
  await new Promise((done, reject) => {
    host.stdout.once("data", done);
    host.once("error", reject);
  });
  const [, nestedPid] = JSON.parse(await readFile(pidsFile, "utf8"));
  let cleanupCalls = 0;
  const trial = await runTrial(
    fanout(1),
    1,
    reportPath,
    {
      timeoutMs: mode === "exit-held-pipes" ? 30_000 : 100,
      tokenDelayMs: 0,
      mode: "lean",
    },
    {
      launch: () => {
        if (mode === "exit-held-pipes") setImmediate(() => host.stdin.write("exit\n"));
        return host;
      },
      cleanupTimeoutMs: mode === "late-drain" ? 2000 : 100,
      drainTimeoutMs: mode === "late-drain" ? 500 : 100,
      ...(mode !== "timeout" && {
        terminate: async (_pid, { signal }) => {
          cleanupCalls++;
          if (mode === "late-drain") {
            const exited = new Promise((done) => host.once("exit", done));
            host.kill("SIGKILL");
            await exited;
            // Close the inherited pipes after cleanup returns but before its
            // drain deadline, independently of the nested Node startup time.
            setTimeout(() => {
              try {
                process.kill(nestedPid, "SIGKILL");
              } catch (error) {
                if (error.code !== "ESRCH") throw error;
              }
            }, 50);
            return;
          }
          if (mode === "cleanup-hang") {
            signal.addEventListener(
              "abort",
              () => {
                void writeFile(join(directory, "aborted.txt"), "aborted");
              },
              { once: true },
            );
            await new Promise(() => {});
          }
          throw new Error("fixture cleanup failed");
        },
      }),
    },
  );
  if (mode === "late-drain") {
    const returned = JSON.stringify(trial);
    await new Promise((done) => setTimeout(done, 650));
    if (returned !== JSON.stringify(trial)) throw new Error("Trial changed after completion");
  }
  console.log(JSON.stringify({ trial, cleanupCalls }));
}
