// Runs the 0.7.0 suite and the engine suite. 0.7.0 supports Linux and macOS only (its package
// declares os: linux, darwin), so its suite is skipped on Windows until E9.5 removes it.
import { spawnSync } from "node:child_process";

const suites = [];
if (process.platform !== "win32") suites.push("test/*.test.mjs");
else console.log("Skipping the 0.7.0 suite: 0.7.0 does not support Windows.");
suites.push("test/engine/**/*.test.ts");
for (const pattern of suites) {
  // A hung test fails after 5 minutes instead of holding CI until the job times out.
  const r = spawnSync(process.execPath, ["--test", "--test-timeout=300000", pattern], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
