// Runs the test suite: the engine's tests and the release script tests.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// The release script tests run where releases run (Linux, macOS); on Windows `npm` is a .cmd.
// Scheduler and workspace tests measure latency. Run them separately after the other
// engine tests so parallel fixtures do not compete with their unchanged timing budgets.
const timed = ["scheduler.test.ts", "workspace.test.ts"];
const engine = readdirSync("test/engine", { recursive: true })
  .filter((file) => file.endsWith(".test.ts") && !timed.includes(file))
  .sort()
  .map((file) => join("test/engine", file));
const suites = [engine, ...timed.map((file) => [join("test/engine", file)])];
if (process.platform !== "win32") suites.push(["test/*.test.mjs"]);
for (const files of suites) {
  // A hung test fails after 5 minutes instead of holding CI until the job times out.
  const r = spawnSync(process.execPath, ["--test", "--test-timeout=300000", ...files], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
