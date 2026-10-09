// The shipped examples (configs and job files) satisfy the engine's input contracts.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateChecks, validateGraph } from "../../engine/core/validate.ts";
import { jobParams, type Job } from "../../engine/headless/main.ts";
import { validateConfig } from "../../engine/pi/config.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = async (file: string) => JSON.parse(await readFile(join(ROOT, file), "utf8"));
const files = async (dir: string) =>
  (await readdir(join(ROOT, dir))).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));

test("example configs and job files satisfy the engine's contracts", async () => {
  for (const file of [...(await files("examples/configs")), "examples/pinata.config.json"]) {
    const { notices } = validateConfig(await json(file));
    assert.deepEqual(notices, [], `${file} uses retired keys`);
  }
  const jobs = [
    ...(await files("examples/jobs")),
    "examples/job.json",
    "examples/scout-job.json",
    "examples/tutorial-build-job.json",
  ];
  for (const file of jobs) {
    const job = (await json(file)) as Job;
    const params = jobParams(job, join(ROOT, file));
    const tasks = validateGraph(params.tasks, { allowWrites: true });
    assert(tasks.length, file);
    validateChecks(params.integratedChecks ?? [], "integratedChecks");
    validateConfig(params.config ?? {});
  }
});
