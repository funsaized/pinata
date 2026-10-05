import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ROOT, readJson, checkedKeys, validateTask, validateChecks } from "../lib/core.mjs";
import { config } from "../lib/pinata.mjs";

const JOB_KEYS = [
  "cwd",
  "approval",
  "allowWrites",
  "instructions",
  "config",
  "tasks",
  "integratedChecks",
  "noIntegratedChecksReason",
];
const files = async (dir) =>
  (await fs.readdir(path.join(ROOT, dir)))
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f));

test("example configs and jobs satisfy the strict input contracts", async () => {
  for (const file of [...(await files("examples/configs")), "examples/pinata.config.json"])
    config(await readJson(path.join(ROOT, file)));
  for (const file of [
    ...(await files("examples/jobs")),
    "examples/job.json",
    "examples/scout-job.json",
    "examples/tutorial-build-job.json",
  ]) {
    const job = await readJson(path.join(ROOT, file));
    checkedKeys(job, JOB_KEYS, file);
    config(job.config ?? {});
    validateChecks(job.integratedChecks ?? []);
    const ids = new Set(job.tasks.map((t) => t.id));
    for (const t of job.tasks) {
      validateTask(t);
      for (const dep of t.after ?? []) assert(ids.has(dep), `${file}: unknown dependency ${dep}`);
      if (t.role === "builder") assert(job.allowWrites, `${file}: builder without allowWrites`);
    }
  }
});
