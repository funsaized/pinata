// Scripted behavior checks; model-backed arena trials are separate.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const boundarySuites = ["apply", "rollback"].map((direction) =>
  join("test/engine", `rewrite-application-${direction}.test.ts`),
);
const engine = readdirSync("test/engine", { recursive: true })
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => join("test/engine", file))
  .filter((file) => !boundarySuites.includes(file));
const suites = [engine];
if (process.platform !== "win32") suites.push(["test/*.test.mjs"]);
// Each exhaustive durability matrix has its own existing 300-second bound.
// Run them separately so unrelated suites do not share their filesystem load.
suites.push(...boundarySuites.map((file) => [file]));
for (const files of suites) {
  const outcome = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=2", "--test-timeout=300000", ...files],
    { stdio: "inherit" },
  );
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) process.exit(outcome.status ?? 1);
}
