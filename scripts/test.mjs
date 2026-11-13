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
// Run exhaustive matrices separately so unrelated suites do not share their
// filesystem load. Their named fault cases each have a 30-second timeout; allow
// the complete matrix more time on slower filesystems without hiding a stuck case.
suites.push(...boundarySuites.map((file) => [file]));
for (const files of suites) {
  const timeout = files.some((file) => boundarySuites.includes(file)) ? 900_000 : 300_000;
  const outcome = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=2", `--test-timeout=${timeout}`, ...files],
    { stdio: "inherit" },
  );
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) process.exit(outcome.status ?? 1);
}
