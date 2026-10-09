// Runs the test suite: the engine's tests and the release script tests.
import { spawnSync } from "node:child_process";

// The release script tests run where releases run (Linux, macOS); on Windows `npm` is a .cmd.
const suites = ["test/engine/**/*.test.ts"];
if (process.platform !== "win32") suites.push("test/*.test.mjs");
for (const pattern of suites) {
  // A hung test fails after 5 minutes instead of holding CI until the job times out.
  const r = spawnSync(process.execPath, ["--test", "--test-timeout=300000", pattern], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
