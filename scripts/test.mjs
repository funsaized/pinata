// Runs the test suite: the engine's tests and the release script tests.
import { spawnSync } from "node:child_process";

for (const pattern of ["test/engine/**/*.test.ts", "test/*.test.mjs"]) {
  // A hung test fails after 5 minutes instead of holding CI until the job times out.
  const r = spawnSync(process.execPath, ["--test", "--test-timeout=300000", pattern], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
