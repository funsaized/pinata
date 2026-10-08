import assert from "node:assert/strict";
import path from "node:path";
import { readJson } from "../lib/core.mjs";
import { init, wait, cancel, cleanup } from "../lib/pinata.mjs";
import { repository } from "./repository.mjs";

assert.ok(
  ["1", "I_AUTHORIZE_PAID_MODEL_CALLS"].includes(process.env.PINATA_LIVE_SMOKE ?? ""),
  "Live spending disabled. Read docs/validation.md before opting in.",
);
assert(process.env.PINATA_LIVE_CONFIG, "Supply an explicit approved model/endpoint config file");
const cfg = await readJson(process.env.PINATA_LIVE_CONFIG);
assert(
  cfg.models?.default,
  "An exact approved default provider/model/thinking selection is required",
);
const repo = await repository("pinata-live-smoke-");
let run;
try {
  run = (
    await init({
      cwd: repo.cwd,
      approval: "Explicit PINATA_LIVE_SMOKE authorization for this read-only, bounded smoke",
      config: {
        ...cfg,
        limits: {
          concurrency: 1,
          startupMs: 30_000,
          taskMs: 60_000,
          jobMs: 120_000,
          maxTurns: 4,
          repairs: 1,
          ...cfg.limits,
        },
      },
      tasks: [
        {
          id: "inspect",
          role: "scout",
          task: "Read a.txt in this disposable repository. Return the required JSON envelope and a concise brief stating its exact contents. Do not edit files, use the network, or delegate.",
          acceptance: ["The brief identifies a.txt and its exact content: original"],
        },
      ],
    })
  ).run;
  let status;
  do status = await wait(run, 90_000);
  while (status.waiting);
  assert.equal(status.tasks[0].status, "succeeded", JSON.stringify(status));
  const evidence = await readJson(path.join(run, "tasks/inspect/1/outcome.json"));
  assert.match(evidence.result.brief, /a\.txt/);
  assert.match(evidence.result.brief, /original/);
  console.log(
    JSON.stringify(
      {
        passed: true,
        run,
        model: status.tasks[0].model,
        limitation: "Read-only single-model smoke, not a persona-quality or cost benchmark",
      },
      null,
      2,
    ),
  );
} finally {
  if (run) {
    await cancel(run);
    console.log(JSON.stringify(await cleanup(run, true)));
  }
  console.log("Retained evidence and fixture repository: " + repo.dir);
}
