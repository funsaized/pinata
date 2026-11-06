import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { executeOffline, readAdapterRequest } from "../../arena/adapters/index.ts";
import { tasks } from "../../arena/corpus/index.ts";
import type { AdapterRequest, ArenaTask, Workflow } from "../../arena/types.ts";

const workflows: Workflow[] = ["sequential", "parallel", "sequential-review", "parallel-review"];

async function setup(t: TestContext, task: ArenaTask, workflow: Workflow) {
  const root = await mkdtemp(join(tmpdir(), "arena-adapters-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "candidate");
  const evidenceDir = join(root, "evidence");
  await cp(task.starterDir, cwd, { recursive: true });
  await mkdir(evidenceDir);
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, ".git", "sentinel"), "starter metadata");
  const request: AdapterRequest = {
    schemaVersion: 1,
    runId: "adapter-test",
    task: { id: task.id, version: task.version, prompt: task.prompt, units: task.units },
    workflow,
    cwd,
    evidenceDir,
    startingRevision: "fixture-starter",
    model: null,
    limits: { timeoutMs: 10_000, maxRepairs: 1 },
  };
  return { root, request, evidence: join(evidenceDir, "offline") };
}

function oracle(task: ArenaTask, cwd: string) {
  const result = spawnSync(process.execPath, [task.oracleFile, cwd], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.ok(result.stdout, result.stderr);
  const score = JSON.parse(result.stdout);
  return { ...score, status: result.status } as {
    passed: number;
    total: number;
    failed: string[];
    status: number;
  };
}

for (const task of tasks) {
  for (const workflow of workflows) {
    test(`arena known-good ${task.id}/${workflow} integrates and passes the external oracle`, async (t) => {
      const { request, evidence } = await setup(t, task, workflow);
      const result = await executeOffline(request, task);
      assert.equal(result.status, "completed", JSON.stringify(result.events));
      assert.equal(result.model, null);
      assert.equal(result.framework.name, "scripted-control");
      assert.deepEqual(result.usage, {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        source: "scripted; no API calls",
      });
      assert.equal(result.attempts, task.units.length);
      assert.equal(result.repairs, 0);
      const score = oracle(task, request.cwd);
      assert.equal(score.passed, score.total, JSON.stringify(score.failed));
      assert.equal(score.status, 0);
      assert.equal(
        await readFile(join(request.cwd, ".git", "sentinel"), "utf8"),
        "starter metadata",
      );

      const [first, second] = task.units;
      assert.ok(first && second);
      const secondTree = join(evidence, "stages", second.id, "worktree");
      const predecessor = first.files[0]!;
      const expectedBase = workflow.startsWith("parallel") ? task.starterDir : task.solutionDir;
      assert.equal(
        await readFile(join(secondTree, predecessor), "utf8"),
        await readFile(join(expectedBase, predecessor), "utf8"),
      );
      assert.ok(!(await readdir(secondTree)).includes(".git"));
      assert.ok(!(await readdir(request.cwd)).includes("oracle.mjs"));
      const starts = result.events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.stage === "builder" && event.status === "started");
      const firstComplete = result.events.findIndex(
        (event) => event.stage === "builder" && event.status === "completed",
      );
      if (workflow.startsWith("parallel"))
        assert.ok(starts.every(({ index }) => index < firstComplete));
      else assert.ok(starts[1]!.index > firstComplete);
      assert.equal(
        result.events.filter((event) => event.stage === "review" && event.status === "started")
          .length,
        workflow.endsWith("-review") ? task.units.length : 0,
      );
      const integrationStart = result.events.findIndex((event) => event.stage === "integration");
      assert.ok(
        result.events
          .filter((event) => event.stage === "handoff")
          .every((event) => result.events.indexOf(event) < integrationStart),
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(evidence, "events.json"), "utf8")),
        result.events,
      );
    });
  }
  test(`arena no-op ${task.id} finishes execution but preserves oracle failure`, async (t) => {
    const { request } = await setup(t, task, "parallel-review");
    const result = await executeOffline(request, task, "noop");
    assert.equal(result.status, "completed");
    assert.equal(result.repairs, 0);
    const score = oracle(task, request.cwd);
    assert.equal(score.status, 1);
    assert.ok(score.passed < score.total);
    for (const unit of task.units) {
      for (const file of unit.files)
        assert.equal(
          await readFile(join(request.cwd, file), "utf8"),
          await readFile(join(task.starterDir, file), "utf8"),
        );
    }
  });
}

for (const workflow of workflows) {
  test(`arena planted repair control ${workflow} records the artificial review treatment`, async (t) => {
    const task = tasks[0]!;
    const { request, evidence } = await setup(t, task, workflow);
    const result = await executeOffline(request, task, "repair-control");
    assert.equal(result.status, "completed");
    const reviewed = workflow.endsWith("-review");
    assert.equal(result.repairs, reviewed ? 1 : 0);
    assert.equal(result.attempts, task.units.length + (reviewed ? 1 : 0));
    assert.equal(oracle(task, request.cwd).status, reviewed ? 0 : 1);
    assert.ok(
      result.limitations.some(
        (line) => line.includes("Artificial repair control") && line.includes("capability"),
      ),
    );
    assert.equal(
      JSON.parse(await readFile(join(evidence, "control.json"), "utf8")).mode,
      "repair-control",
    );
    if (reviewed) {
      const unit = task.units[0]!;
      assert.match(
        await readFile(join(evidence, "stages", unit.id, "builder-output", unit.files[0]!), "utf8"),
        /arena scripted planted defect/,
      );
      assert.equal(
        JSON.parse(await readFile(join(evidence, "stages", unit.id, "repair.json"), "utf8"))
          .verified,
        true,
      );
    }
  });
}

test("arena repair budget zero and broken controls retain the planted failure with review", async (t) => {
  const task = tasks[0]!;
  for (const mode of ["repair-control", "broken"] as const) {
    const { request } = await setup(t, task, "parallel-review");
    request.limits.maxRepairs = 0;
    const result = await executeOffline(request, task, mode);
    assert.equal(result.status, "completed");
    assert.equal(result.repairs, 0);
    assert.equal(oracle(task, request.cwd).status, 1);
    assert.ok(
      result.events.some(
        (event) => event.stage === "review" && event.status === "differences-found",
      ),
    );
  }
});

test("arena integration rejects overlapping owners after retaining isolated successful stages", async (t) => {
  const source = tasks[0]!;
  const first = source.units[0]!;
  const task: ArenaTask = { ...source, units: [first, { ...first, id: "duplicate-owner" }] };
  const { request, evidence } = await setup(t, task, "parallel");
  const result = await executeOffline(request, task);
  assert.equal(result.status, "failed");
  assert.equal(result.events.filter((event) => event.stage === "handoff").length, 2);
  assert.ok(
    result.events.some(
      (event) =>
        event.stage === "integration" &&
        event.status === "failed" &&
        event.detail?.includes("Overlapping file ownership"),
    ),
  );
  for (const unit of task.units)
    assert.ok(
      JSON.parse(await readFile(join(evidence, "stages", unit.id, "handoff.json"), "utf8")).changed
        .length > 0,
    );
  assert.equal(
    await readFile(join(request.cwd, first.files[0]!), "utf8"),
    await readFile(join(task.starterDir, first.files[0]!), "utf8"),
  );
});

test("arena failed parallel builder retains sibling evidence without integrating any changes", async (t) => {
  const source = tasks[0]!;
  const task: ArenaTask = {
    ...source,
    units: [
      ...source.units,
      { id: "missing-reference", prompt: "fixture", files: ["missing.mjs"] },
    ],
  };
  const { request, evidence } = await setup(t, task, "parallel");
  const result = await executeOffline(request, task);
  assert.equal(result.status, "failed");
  assert.equal(result.attempts, task.units.length);
  assert.equal(
    result.events.filter((event) => event.stage === "handoff").length,
    source.units.length,
  );
  assert.ok(!result.events.some((event) => event.stage === "integration"));
  assert.match(
    await readFile(join(evidence, "stages", "missing-reference", "failure.json"), "utf8"),
    /Reference file missing/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(evidence, "events.json"), "utf8")),
    result.events,
  );
  for (const unit of source.units) {
    for (const file of unit.files)
      assert.equal(
        await readFile(join(request.cwd, file), "utf8"),
        await readFile(join(task.starterDir, file), "utf8"),
      );
  }
});

test("arena rejects traversal and evidence inside the candidate before running builders", async (t) => {
  const source = tasks[0]!;
  const task: ArenaTask = {
    ...source,
    units: [{ id: "escape", prompt: "fixture", files: ["../escape.mjs"] }],
  };
  const { request } = await setup(t, task, "sequential");
  const unsafe = await executeOffline(request, task);
  assert.equal(unsafe.status, "failed");
  assert.equal(unsafe.attempts, 0);
  assert.ok(unsafe.events.some((event) => event.detail?.includes("Unsafe candidate path")));
  await mkdir(join(request.cwd, "..hidden-evidence"));
  const inside = await executeOffline(
    { ...request, evidenceDir: join(request.cwd, "..hidden-evidence") },
    source,
  );
  assert.equal(inside.status, "failed");
  assert.ok(inside.events.some((event) => event.detail?.includes("outside the candidate")));
});

test("arena refuses evidence reuse without overwriting the retained first execution", async (t) => {
  const task = tasks[0]!;
  const { request, evidence } = await setup(t, task, "parallel");
  assert.equal((await executeOffline(request, task, "noop")).status, "completed");
  const original = await readFile(join(evidence, "events.json"), "utf8");
  const repeat = await executeOffline(request, task, "known-good");
  assert.equal(repeat.status, "failed");
  assert.equal(repeat.attempts, 0);
  assert.equal(await readFile(join(evidence, "events.json"), "utf8"), original);
  assert.equal(JSON.parse(await readFile(join(evidence, "control.json"), "utf8")).mode, "noop");
});

test("arena external protocol helper accepts a public request and preserves stdout JSON/error exit", async (t) => {
  const { root, request } = await setup(t, tasks[0]!, "sequential");
  const requestFile = join(root, "request.json");
  await writeFile(requestFile, JSON.stringify(request));
  assert.deepEqual(await readAdapterRequest(requestFile), request);
  const protocol = new URL("../../arena/adapters/protocol.ts", import.meta.url).href;
  const wrapper = join(root, "wrapper.mjs");
  await writeFile(
    wrapper,
    `import {runProtocol} from ${JSON.stringify(protocol)};\nawait runProtocol(async request => ({schemaVersion:1, marker:request.runId}));\n`,
  );
  const good = spawnSync(process.execPath, [wrapper, requestFile], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), { schemaVersion: 1, marker: "adapter-test" });
  await writeFile(requestFile, JSON.stringify({ ...request, model: undefined }));
  await assert.rejects(readAdapterRequest(requestFile), /Invalid arena adapter request/);
  const bad = spawnSync(process.execPath, [wrapper, requestFile], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /Invalid arena adapter request/);
});
