// Baseline-characterization and feasibility probes; deliberately outside npm test.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const help = spawnSync(process.execPath, ["--help"], { encoding: "utf8" });
if (help.status !== 0) throw new Error("Cannot inspect Node's test-runner options");
const isolation = help.stdout.includes("  --test-isolation=")
  ? "--test-isolation=none"
  : "--experimental-test-isolation=none";
const files = readdirSync("test/readiness")
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => join("test/readiness", file));
if (!files.length) throw new Error("No readiness probes found");
const result = spawnSync(
  process.execPath,
  ["--test", isolation, "--test-timeout=120000", ...files],
  {
    stdio: "inherit",
  },
);
process.exitCode = result.status ?? 1;
