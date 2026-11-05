import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { executeOffline } from "../../arena/adapters/offline.ts";
import { renderReport } from "../../arena/report.ts";
import { runArena, type RunResult } from "../../arena/runner.ts";
import { verifyTreatment } from "../../arena/treatment.ts";
import type { AdapterRequest, AdapterResponse, ArenaTask, Workflow } from "../../arena/types.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "arena-treatment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const starterDir = join(root, "starter");
  const solutionDir = join(root, "solution");
  mkdirSync(starterDir);
  mkdirSync(solutionDir);
  for (const id of ["a", "b"]) {
    writeFileSync(join(starterDir, `${id}.mjs`), "export const answer = 0;\n");
    writeFileSync(join(solutionDir, `${id}.mjs`), "export const answer = 42;\n");
  }
  const oracleFile = join(root, "oracle.mjs");
  writeFileSync(
    oracleFile,
    `import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {writeFileSync} from 'node:fs';
let ok=false;try{ok=(await import(pathToFileURL(join(process.argv[2],'a.mjs')))).answer===42}catch{}
writeFileSync(Number(process.env.ARENA_SCORE_FD),JSON.stringify({schemaVersion:1,passed:ok?1:0,total:1,failed:ok?[]:['answer must equal 42'],cases:[{id:0,passed:ok,...(ok?{}:{error:'answer must equal 42'})}]}));process.exitCode=ok?0:1;`,
  );
  const task: ArenaTask = {
    id: "treatment",
    version: 1,
    title: "Treatment fixture",
    prompt: "Export answer 42",
    starterDir,
    solutionDir,
    oracleFile,
    oracleCaseCount: 1,
    units: ["a", "b"].map((id) => ({ id, files: [`${id}.mjs`], prompt: "Implement answer" })),
  };
  const options = {
    out: join(root, "results"),
    tasks: [task],
    workflows: ["parallel-review"] as Workflow[],
    timeoutMs: 5000,
  };
  async function control(workflow: Workflow = "parallel-review", maxRepairs = 1) {
    const cwd = mkdtempSync(join(root, "candidate-"));
    const evidenceDir = mkdtempSync(join(root, "evidence-"));
    for (const id of ["a", "b"])
      writeFileSync(join(cwd, `${id}.mjs`), "export const answer = 0;\n");
    const request: AdapterRequest = {
      schemaVersion: 1,
      runId: "fixture",
      task: { id: task.id, version: task.version, prompt: task.prompt, units: task.units },
      workflow,
      cwd,
      evidenceDir,
      startingRevision: "fixture",
      model: null,
      limits: { timeoutMs: 5000, maxRepairs },
    };
    const response = await executeOffline(request, task, "repair-control");
    return {
      mode: "scripted-control" as const,
      workflow,
      unitIds: task.units.map((unit) => unit.id),
      maxRepairs,
      response,
    };
  }
  return { root, options, control };
}

test("verified controls check actual harness traces across workflows and zero repair budget", async (t) => {
  const { control } = fixture(t);
  for (const workflow of [
    "sequential",
    "parallel",
    "sequential-review",
    "parallel-review",
  ] as const) {
    for (const maxRepairs of [0, 1]) {
      const input = await control(workflow, maxRepairs);
      const result = verifyTreatment(input);
      assert.equal(result.status, "verified-control", result.reasons.join("\n"));
      assert.match(result.reasons.join(" "), /no live model or framework/);
    }
  }
});

test("external copied control traces and self-reported verification never establish treatment", async (t) => {
  const { control } = fixture(t);
  const input = await control();
  const response = { ...input.response, verified: true, treatment: { status: "verified-control" } };
  const result = verifyTreatment({ ...input, mode: "external", response });
  assert.equal(result.status, "unverified");
  assert.match(result.reasons.join(" "), /supervisor-owned workflow evidence is not implemented/);
});

test("empty external events, unknown counts and reported budget overruns remain unverified", async (t) => {
  const { control } = fixture(t);
  const input = await control();
  const unknown = verifyTreatment({
    ...input,
    mode: "external",
    response: { ...input.response, events: [], attempts: null, repairs: null },
  });
  assert.equal(unknown.status, "unverified");
  assert.match(unknown.reasons.join(" "), /No stage events.*counts are unknown/);
  const overrun = verifyTreatment({ ...input, mode: "external", maxRepairs: 0 });
  assert.equal(overrun.status, "unverified");
  assert.match(overrun.reasons.join(" "), /exceed the requested repair budget/);
});

test("control verification rejects unknown stages, missing review and broken scheduling", async (t) => {
  const { control } = fixture(t);
  const input = await control();
  const malformed: Array<[string, AdapterResponse["events"]]> = [
    [
      "unsupported stage",
      [...input.response.events, { stage: "pretend-supervisor", status: "verified" }],
    ],
    [
      "unknown unit",
      input.response.events.map((event) =>
        event.unit === "a" ? { ...event, unit: "unknown" } : event,
      ),
    ],
    ["missing review", input.response.events.filter((event) => event.stage !== "review")],
    ["empty trace", []],
  ];
  for (const [name, events] of malformed)
    assert.equal(
      verifyTreatment({ ...input, response: { ...input.response, events } }).status,
      "invalid",
      name,
    );
  const sequential = await control("sequential-review");
  const serialized = verifyTreatment({ ...sequential, workflow: "parallel-review" });
  assert.equal(serialized.status, "invalid");
  assert.match(serialized.reasons.join(" "), /did not all start/);
});

test("control counts must match recorded attempts and the requested repair budget", async (t) => {
  const { control } = fixture(t);
  const input = await control();
  for (const counts of [{ attempts: null }, { repairs: null }, { attempts: 100 }, { repairs: 0 }])
    assert.equal(
      verifyTreatment({ ...input, response: { ...input.response, ...counts } }).status,
      "invalid",
    );
  const overrun = verifyTreatment({ ...input, maxRepairs: 0 });
  assert.equal(overrun.status, "invalid");
  assert.match(overrun.reasons.join(" "), /exceeded the requested repair budget/);
  assert.equal(verifyTreatment({ ...input, response: null }).status, "unverified");
  assert.equal(
    verifyTreatment({ ...input, response: { ...input.response, status: "failed" } }).status,
    "invalid",
  );
});

test("correct external candidate with unknown stages stays outside treatment comparisons", async (t) => {
  const { root, options } = fixture(t);
  const script = join(root, "adapter.mjs");
  const response = {
    schemaVersion: 1,
    status: "completed",
    framework: { name: "scripted-control", version: "1" },
    model: null,
    usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unknown" },
    attempts: null,
    repairs: null,
    events: [{ stage: "made-up-stage", status: "verified" }],
    limitations: [],
    comparisonEligible: true,
    treatment: { status: "verified-control", reasons: [] },
  };
  writeFileSync(
    script,
    `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));writeFileSync(join(request.cwd,'a.mjs'),'export const answer=42;');console.log(JSON.stringify(${JSON.stringify(response)}));`,
  );
  const {
    directory,
    results: [result],
  } = await runArena({
    ...options,
    adapter: { name: "pretend-verified", command: process.execPath, args: [script] },
    allowExternal: true,
    maxRepairs: 0,
  });
  assert.equal(result!.candidateCorrect, true);
  assert.equal(result!.treatment.status, "unverified");
  assert.equal(result!.comparisonEligible, false);
  const report = readFileSync(join(directory, "report.md"), "utf8");
  assert.match(report, /\| completed \| pass \| unverified \| no \|/);
  assert.match(report, /Excluded external trials: 1\/1 requested cells; 1 passing candidates/);
  const comparison = report
    .split("## Scripted control treatment comparisons")[1]!
    .split("## Evidence and failures")[0]!;
  assert.doesNotMatch(comparison, /\| treatment \|/);
  assert.match(report, /matching hash does not establish adapter equivalence/);
});

test("reports retain failed and unstarted controls while excluding external and legacy artifacts", async (t) => {
  const { options } = fixture(t);
  const {
    results: [original],
  } = await runArena(options);
  assert.ok(original);
  const failed = structuredClone(original);
  failed.runId = "failed-control";
  failed.status = "failed";
  failed.candidateCorrect = false;
  failed.treatment = { status: "invalid", reasons: ["Control evidence failed"] };
  failed.response = null;
  failed.oracle = null;
  const pending = structuredClone(failed);
  pending.runId = "pending-control";
  pending.status = "pending";
  pending.candidateCorrect = null;
  pending.treatment = { status: "unverified", reasons: ["No evidence"] };
  const external = structuredClone(original);
  external.runId = "self-claimed-control";
  external.mode = "external";
  external.control = null;
  // Even an artifact claiming eligibility cannot convert an external run to a control.
  external.comparisonEligible = true;
  const legacy: RunResult = structuredClone(original);
  legacy.runId = "legacy-control";
  for (const field of ["candidateCorrect", "treatment", "comparisonEligible"])
    Reflect.deleteProperty(legacy, field);
  const report = renderReport([original, failed, pending, external, legacy]);
  assert.match(report, /5 requested trial cells recorded/);
  assert.match(report, /\| 1\/3 \| 1\/3 \| 1\/3 \|/);
  assert.match(report, /Excluded external trials: 1\/5 requested cells/);
  assert.match(report, /Other excluded trials without explicit comparison eligibility: 1\/5/);
  assert.match(report, /\| completed \| unknown \| unverified \| no \|/);
  assert.doesNotMatch(report, /\| 1\/1 \| 1\/1 \| 1\/1 \|/);
});
