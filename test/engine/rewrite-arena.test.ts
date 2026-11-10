import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../arena/process.ts";
import { readMatrix } from "../../arena/matrix.ts";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Observer, reconcileObservations, treatmentEvidence } from "../../arena/observer.ts";
import { allocateBatch, cellState, readBatch, startCell } from "../../arena/ledger.ts";
import { EvidenceStore, materializeSnapshot } from "../../arena/evidence.ts";
import { freezeTask, loadTask, prepareOracle } from "../../arena/corpus.ts";
import { validateScore } from "../../arena/oracle.ts";
import { defaultCondition, defaultLimits, runArena } from "../../arena/runner.ts";
import { renderReport, reportBatches } from "../../arena/report.ts";
import { sourceClosureSchema, type Source } from "../../arena/contracts.ts";
import { nativeInvocation } from "../../arena/adapters.ts";

const execute = promisify(execFile);
async function directory(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pinata-rewrite-arena-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const usage = (input: number) => ({ input, output: 1, cacheRead: 2, cacheWrite: 3, cost: null });

test("arena F5 reconciles mixed response and settlement totals for every assignment, retry and child", () => {
  const observer = new Observer();
  for (const [worker, attempt, parentAttempt] of [
    ["coordinator", "a", undefined],
    ["worker", "b", "a"],
    ["worker", "c", "a"],
  ])
    observer.record({
      kind: "start",
      run: "run",
      worker,
      assignment: worker === "worker" ? 2 : 1,
      attempt,
      ...(parentAttempt ? { parentAttempt } : {}),
    });
  observer.record({
    kind: "start",
    run: "run",
    worker: "worker",
    assignment: 2,
    attempt: "b",
    parentAttempt: "a",
  });
  observer.record({ kind: "response", attempt: "a", response: "r", state: "completed" });
  observer.record({
    kind: "usage",
    observation: {
      attempt: "a",
      source: "message",
      kind: "response",
      responseId: "r",
      usage: usage(10),
    },
  });
  observer.record({
    kind: "usage",
    observation: { attempt: "b", source: "settlement", kind: "attempt_total", usage: usage(20) },
  });
  observer.record({
    kind: "usage",
    observation: { attempt: "c", source: "settlement", kind: "attempt_total", usage: usage(30) },
  });
  for (const attempt of ["a", "b", "c"])
    observer.record({ kind: "settled", attempt, complete: true });
  const result = reconcileObservations(observer.records);
  assert.equal(result.complete, true);
  assert.deepEqual(result.total, { input: 60, output: 3, cacheRead: 6, cacheWrite: 9, cost: null });
  observer.record({
    kind: "start",
    run: "run",
    worker: "nested",
    assignment: 1,
    attempt: "d",
    parentAttempt: "b",
  });
  observer.record({ kind: "settled", attempt: "d", complete: false });
  const partial = reconcileObservations(observer.records);
  assert.equal(partial.complete, false);
  assert.equal(partial.total, null);
  assert.equal(partial.observedTotal?.input, 60);
  assert.deepEqual(partial.missingAttempts, ["d"]);
  observer.record({ truncated: true });
  assert.match(reconcileObservations(observer.records).reason ?? "", /Malformed/);
});

test("arena adapter workflow claims never become independent attestation", () => {
  const observer = new Observer();
  for (const action of ["start", "end"])
    observer.record({ kind: "stage", stage: "build", action, subject: "worker" });
  const result = treatmentEvidence(observer.records, {
    offline: false,
    cleanupConfirmed: true,
    expectedStages: ["build"],
  });
  assert.equal(result.verified, false);
  assert.equal(result.comparisonEligible, false);
});

async function source(store: EvidenceStore): Promise<Source> {
  const closure = await store.json({ schemaVersion: 2, roots: [], files: [] });
  return {
    schemaVersion: 2,
    revision: null,
    diff: null,
    lockfile: null,
    closure,
    dependencyCoverage: "unknown",
    limitations: ["Test fixture"],
    node: process.version,
    pi: null,
    platform: process.platform,
    architecture: process.arch,
    machine: { cpus: 1, memory: 1, load: [0] },
  };
}
test("arena durable allocation retains pending and interrupted cells and refuses automatic replay", async (t) => {
  const root = await directory(t);
  const store = new EvidenceStore(join(root, "prepared"));
  const frozen = await freezeTask(await loadTask("checkout"), store);
  const requested = defaultCondition({ kind: "offline", mode: "known-good" }, "sequential");
  const batch = await allocateBatch(
    root,
    {
      source: await source(store),
      limits: defaultLimits,
      cells: [1, 2].map((trial) => ({
        task: "checkout",
        taskVersion: 1,
        taskDigest: frozen.digest,
        taskEvidence: frozen.evidence,
        trial,
        requested,
      })),
    },
    { artifactSource: store },
  );
  assert.equal(batch.cells.length, 2);
  await startCell(batch, batch.cells[0].cell.id);
  const reopened = await readBatch(batch.directory);
  assert.deepEqual(reopened.cells.map(cellState), ["interrupted_unknown", "pending"]);
  await assert.rejects(startCell(reopened, reopened.cells[0].cell.id), /uncertain active/);
  assert.match(renderReport([reopened]), /Requested cells: 2/);
  await assert.rejects(reportBatches([batch.directory, batch.directory]), /Duplicate batch/);
  const manifestFile = join(batch.directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.cells[1].id = manifest.cells[0].id;
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(readBatch(batch.directory), /Duplicate/);
});

test("replacement oracle preserves original literal cases and isolates candidate output", async (t) => {
  const root = await directory(t);
  const store = new EvidenceStore(join(root, "artifacts"));
  for (const id of ["checkout", "reservations", "incidents"]) {
    const task = await freezeTask(await loadTask(id), store);
    const directory = join(root, id);
    const oracle = await prepareOracle(task, store, directory);
    const candidate = join(root, `${id}-candidate`);
    await materializeSnapshot(task.solution, store, candidate);
    const good = await execute(process.execPath, [oracle.file, candidate], {
      env: { PATH: process.env.PATH, ARENA_ORACLE_TIMEOUT_MS: "10000" },
    });
    const score = validateScore(JSON.parse(good.stdout), task.task.oracleCaseCount);
    assert.equal(score.passed, task.task.oracleCaseCount, good.stderr);
    const first = task.starter.files[0];
    await writeFile(join(candidate, first.path), await store.read(first.artifact));
    await assert.rejects(execute(process.execPath, [oracle.file, candidate]), (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error);
      const failed = validateScore(JSON.parse(String(error.stdout)), task.task.oracleCaseCount);
      assert.ok(failed.passed < task.task.oracleCaseCount);
      return true;
    });
  }
});

test("replacement arena runs supervised offline controls and retains complete immutable results", async (t) => {
  const root = await directory(t);
  const batch = await runArena({
    out: root,
    repositoryRoot: process.cwd(),
    tasks: [{ id: "checkout" }],
    workflows: ["parallel-review"],
    adapter: { kind: "offline", mode: "repair-control" },
  });
  const reopened = await readBatch(batch.directory);
  const result = reopened.cells[0].results[0];
  assert.equal(result.state, "completed", JSON.stringify(result.reasons));
  assert.equal(result.oracle.state, "pass", JSON.stringify(result.oracle));
  assert.equal(result.usage.complete, true);
  assert.equal(result.treatment.verified, true);
  assert.equal(result.treatment.comparisonEligible, false);
  assert.ok(result.snapshots.length >= 2);
  assert.match(renderReport([reopened]), /Passing delivered candidates: 1/);
});

test("native adapters retain ordinary tools and new commands without launching a model", async (t) => {
  const root = await directory(t);
  const store = new EvidenceStore(join(root, "artifacts"));
  const task = await freezeTask(await loadTask("checkout"), store);
  const adapter = { kind: "native", system: "pinata", command: "pi", args: [] } as const;
  const requested = {
    ...defaultCondition({ ...adapter, args: [] }, "native"),
    model: { provider: "fixture", id: "scripted", version: null, settings: {} },
  };
  const invocation = nativeInvocation({
    adapter: { ...adapter, args: [] },
    task,
    candidate: root,
    directory: root,
    requested,
    limits: defaultLimits,
  });
  assert.ok(invocation.args.includes("--print"));
  assert.match(invocation.args.at(-1) ?? "", /kind:create/);
  assert.match(invocation.args.at(-1) ?? "", /Ordinary coding tools remain available/);
  assert.doesNotMatch(invocation.args.join(" "), /verified integration|pinata_changes.*whole run/);
});

test("arena A3 real process death after batch allocation keeps the original matrix cell", async (t) => {
  const root = await directory(t);
  const sourceRoot = join(root, "source");
  const marker = "export const allocationFixture = true;\n";
  await mkdir(join(sourceRoot, "engine"), { recursive: true });
  await writeFile(join(sourceRoot, "package.json"), '{"name":"arena-allocation-fixture"}\n');
  await writeFile(join(sourceRoot, "engine", "fixture.ts"), marker);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./fixtures/rewrite-arena-child.ts", import.meta.url)),
      root,
      sourceRoot,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  t.after(() => {
    child.kill("SIGKILL");
  });
  const started = await new Promise<{ batch: string; cell: string }>((accept, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Child did not publish allocation: ${stderr}`));
    }, 15000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (bytes) => {
      buffered += bytes;
      if (!buffered.includes("\n")) return;
      clearTimeout(timer);
      accept(JSON.parse(buffered.split("\n")[0]));
    });
  });
  const closed = new Promise((accept) => child.once("close", accept));
  child.kill("SIGKILL");
  await closed;
  const retained = await readMatrix(dirname(started.batch));
  assert.equal(retained.schedule.cells.length, 2);
  assert.equal(retained.batches[0]?.cells[0].cell.id, started.cell);
  const retainedBatch = retained.batches[0];
  assert.ok(retainedBatch);
  const closure = sourceClosureSchema.parse(
    JSON.parse((await retainedBatch.store.read(retainedBatch.manifest.source.closure)).toString()),
  );
  const sourceMarker = closure.files.find((file) => file.path === "engine/fixture.ts");
  assert.ok(sourceMarker);
  assert.equal((await retainedBatch.store.read(sourceMarker.artifact)).toString(), marker);
  assert.equal(cellState(retainedBatch.cells[0]), "interrupted_unknown");
  assert.equal(retained.batches[1], null);
  const again = await readMatrix(dirname(started.batch));
  assert.deepEqual(again.schedule, retained.schedule);
  assert.match(renderReport([retainedBatch]), /interrupted_unknown/);
  const report = await reportBatches([dirname(started.batch)]);
  assert.match(report, /pending/);
  assert.match(report, /interrupted_unknown/);
});

test("arena private score pipe rejects counterfeit candidate scores", async (t) => {
  const root = await directory(t);
  const store = new EvidenceStore(join(root, "artifacts"));
  const task = await freezeTask(await loadTask("checkout"), store);
  const oracle = await prepareOracle(task, store, join(root, "oracle"));
  const candidate = join(root, "candidate");
  await materializeSnapshot(task.starter, store, candidate);
  const original = await readFile(join(candidate, "items.mjs"), "utf8");
  await writeFile(
    join(candidate, "items.mjs"),
    `process.stdout.write(JSON.stringify({schemaVersion:1,passed:999,total:999,failed:[],cases:[]})+"\\n");\n${original}`,
  );
  await assert.rejects(
    execute(process.execPath, [oracle.launcher, oracle.file, candidate]),
    (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error && "stderr" in error);
      const score = validateScore(JSON.parse(String(error.stdout)), 20);
      assert.ok(score.passed < 20);
      assert.match(String(error.stderr), /999/);
      return true;
    },
  );
});

test("arena process deadline keeps a timed-out attempt and confirmed cleanup evidence", async (t) => {
  const root = await directory(t);
  const store = new EvidenceStore(join(root, "artifacts"));
  const result = await runProcess({
    directory: join(root, "supervisor"),
    command: process.execPath,
    args: ["-e", "process.stdout.write('retained before deadline'); setInterval(() => {}, 1000)"],
    cwd: root,
    limits: { ...defaultLimits, timeoutMs: 1000 },
    store,
  });
  assert.equal(result.state, "timed_out");
  assert.equal(result.cleanup.status, "stopped", JSON.stringify(result.cleanup));
  assert.ok(result.evidence.length > 0);
  for (const reference of result.evidence) await store.read(reference);
});

test("arena historical reader retains all v1 cells without upgrading verification", async (t) => {
  const root = await directory(t);
  const manifest = {
    schemaVersion: 1,
    batchId: "historical-fixture",
    trials: 2,
    workflows: ["native"],
    tasks: [{ id: "checkout", version: 1 }],
  };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  for (let trial = 1; trial <= 2; trial++) {
    const runId = `checkout-native-trial-${trial}`;
    const directory = join(root, "runs", runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify({
        schemaVersion: 1,
        batchId: manifest.batchId,
        runId,
        trial,
        order: trial,
        task: { id: "checkout", version: 1, title: "Checkout" },
        workflow: "native",
        status: trial === 1 ? "failed" : "pending",
        candidateCorrect: null,
        comparisonEligible: true,
        errors: [],
        oracle: null,
      }),
    );
  }
  const report = await reportBatches([root]);
  assert.match(report, /without upgrading workflow verification/);
  assert.match(report, /checkout-native-trial-1/);
  assert.match(report, /checkout-native-trial-2/);
  await rm(join(root, "runs", "checkout-native-trial-2", "result.json"));
  await assert.rejects(reportBatches([root]));
});
