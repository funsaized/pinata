import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { readJson } from "../lib/core.mjs";
import { init, wait, cleanup, cancel } from "../lib/pinata.mjs";
// helpers.mjs isolates unit tests from the personal Pi agent directory; a live
// run needs the real one for its models and authentication.
const agentDir = process.env.PI_CODING_AGENT_DIR;
const { repository, gitIn } = await import("./helpers.mjs");
if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = agentDir;

// Opt-in live run: real Pi, Herdr, and models review uncommitted work with a
// seeded bug, under a cost limit. Nothing is written to the fixture checkout.
assert.equal(
  process.env.PINATA_LIVE_SMOKE,
  "I_AUTHORIZE_PAID_MODEL_CALLS",
  "Live spending disabled. Read docs/testing.md before opting in.",
);
assert(process.env.PINATA_LIVE_CONFIG, "Supply an approved model config file");
const cfg = await readJson(process.env.PINATA_LIVE_CONFIG);
const repo = await repository("pinata-e2e-review-");
const write = (file, data) => fs.writeFile(path.join(repo.cwd, file), data);
await write(
  "page.mjs",
  `// Returns the items on a 1-based page.\nexport function page(items, number, size) {\n  const start = (number - 1) * size;\n  return items.slice(start, start + size);\n}\n`,
);
await gitIn(repo.cwd, "add", "page.mjs");
await gitIn(repo.cwd, "commit", "-qm", "Add paging");
// The uncommitted change under review drops the last item of every page.
await write(
  "page.mjs",
  `// Returns the items on a 1-based page. Rejects pages below 1.\nexport function page(items, number, size) {\n  if (number < 1) throw new RangeError("page numbers start at 1");\n  const start = (number - 1) * size;\n  return items.slice(start, start + size - 1);\n}\n`,
);
const before = await fs.readFile(path.join(repo.cwd, "page.mjs"), "utf8");

let run;
try {
  const created = await init({
    cwd: repo.cwd,
    approval: "Explicit PINATA_LIVE_SMOKE authorization for this disposable read-only review",
    allowWrites: false,
    config: { ...cfg, limits: { taskMs: 900_000, jobMs: 1_800_000, costUsd: 5 } },
    tasks: [
      {
        id: "correctness",
        role: "reviewer",
        reviewBase: "HEAD",
        task: "Review the uncommitted change to page.mjs for logic errors and regressions.",
        acceptance: [
          "Every finding cites file:line evidence and a concrete failing input.",
          "Approve only if the change is correct.",
        ],
      },
      {
        id: "tests",
        role: "reviewer",
        reviewBase: "HEAD",
        task: "Review whether this change is covered by tests, and name what is untested.",
        acceptance: ["Name the tests covering the change, or say none do."],
      },
    ],
  });
  run = created.run;
  assert.deepEqual(created.base.uncommittedFiles, ["page.mjs"]);
  let status;
  do status = await wait(run, 300_000);
  while (status.waiting);
  for (const t of status.tasks)
    assert(["succeeded", "rejected"].includes(t.status), JSON.stringify(status, null, 2));
  const correctness = await readJson(path.join(run, "tasks/correctness/1/outcome.json"));
  const target = (await readJson(path.join(run, "tasks/correctness/1/task.json"))).reviewTarget;
  assert.equal(target.subject.kind, "uncommitted");
  assert.equal(correctness.result.review.fingerprint, target.fingerprint);
  assert.equal(
    correctness.status,
    "rejected",
    "the reviewer missed the seeded off-by-one: " + JSON.stringify(correctness.result),
  );
  assert(correctness.result.findings.some((f) => /page\.mjs/.test(f.evidence)));
  assert.equal(await fs.readFile(path.join(repo.cwd, "page.mjs"), "utf8"), before);
  console.log(
    JSON.stringify(
      {
        passed: true,
        run,
        statuses: Object.fromEntries(status.tasks.map((t) => [t.id, t.status])),
        spend: status.spend,
        findings: correctness.result.findings,
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
