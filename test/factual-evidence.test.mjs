import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { validateTask, readJson } from "../lib/core.mjs";
import { outcome } from "../lib/evidence.mjs";
import { fixture, task, settled } from "./helpers.mjs";

const check = (code) => ({ id: "value", argv: [process.execPath, "-e", code] });

test("a completed report exposes targeted supervisor observations without certifying every claim", async (t) => {
  const f = await fixture(t, [
    task("plain"),
    task(
      "observed",
      "scout",
      {},
      { evidenceChecks: [check('console.log("seconds2=2 (current code)")')] },
    ),
  ]);
  const result = await settled(f);
  assert(result.tasks.every((x) => x.status === "succeeded"));
  assert.equal(result.tasks[0].verification.claims, "not-automatically-verified");
  assert.equal(result.tasks[0].verification.factualEvidence.length, 0);
  const evidence = result.tasks[1].verification.factualEvidence[0];
  assert.equal(evidence.passed, true);
  assert.match(
    await fs.readFile(path.join(f.run, "tasks/observed/1", evidence.log), "utf8"),
    /seconds2=2/,
  );
  const run = await f.manifest();
  await outcome(run, run.tasks[1]);
  const log = path.join(f.run, "tasks/observed/1", evidence.log),
    original = await fs.readFile(log);
  await fs.writeFile(log, "seconds2=2000 (tampered)\n");
  await assert.rejects(outcome(run, run.tasks[1]), /Check output changed/);
  await fs.writeFile(log, original);
  const file = path.join(f.run, "tasks/observed/1/outcome.json");
  const saved = await readJson(file);
  saved.checks[0].argv = ["false"];
  await fs.writeFile(file, JSON.stringify(saved));
  await assert.rejects(
    outcome(run, run.tasks[1]),
    /archived outcome changed|verification evidence missing/,
  );
});

test("failed or mutating factual checks cannot certify an inspection", async (t) => {
  const f = await fixture(t, [
    task("wrong", "scout", {}, { evidenceChecks: [check("process.exit(1)")] }),
    task(
      "writes",
      "scout",
      {},
      { evidenceChecks: [check('require("fs").writeFileSync("a.txt", "changed")')] },
    ),
  ]);
  const result = await settled(f);
  assert(result.tasks.every((x) => x.status === "failed"));
  assert.equal(result.tasks[0].failureStage, "verification");
  assert.match(result.tasks[1].error, /Inspection persona modified/);
});

test("acceptance and factual checks cannot overwrite each other's evidence logs", () => {
  assert.throws(
    () =>
      validateTask(
        task(
          "build",
          "builder",
          {},
          {
            ownership: ["a.txt"],
            checks: [check("1")],
            evidenceChecks: [check("2")],
          },
        ),
      ),
    /Duplicate check ID/,
  );
});
