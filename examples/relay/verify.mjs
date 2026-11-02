// A destination check independent of the agent-written tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = dirname(fileURLToPath(import.meta.url));
const actual = spawnSync(process.execPath, ["bin/relay.mjs", "data/events.jsonl"], {
  cwd,
  encoding: "utf8",
  timeout: 10_000,
});
assert.ifError(actual.error);
assert.equal(actual.status, 0, actual.stderr || "Relay exited unsuccessfully");
assert.equal(actual.stderr, "", "The valid sample should not emit errors");
assert.equal(
  actual.stdout,
  await readFile(join(cwd, "expected-report.md"), "utf8"),
  "CLI output differs from expected-report.md",
);
console.log("Relay output matches expected-report.md.");
