import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { scenarios, historySweep } from "../../bench/workloads.ts";
import { executionFailures, overBudget, comparison, selectBudgets } from "../../bench/gates.ts";
import {
  allocateCell,
  parseDarwinFilesystem,
  readReport,
  reserveOutput,
  storageProvenance,
} from "../../bench/evidence.ts";
import { main, parse } from "../../bench/run.ts";
import {
  benchResultSchema,
  budgetConfigurationSchema,
  type BenchResult,
  type CellSpec,
} from "../../bench/types.ts";
import { Observer } from "../../bench/observer.ts";
import { resourcePlateau } from "../../bench/profile.ts";
import { runCell } from "../../bench/engine.ts";

const budgetConfiguration = budgetConfigurationSchema.parse(
  JSON.parse(await readFile(new URL("../../bench/budgets.json", import.meta.url), "utf8")),
);

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "pinata-rewrite-bench-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function spec(path: string): CellSpec {
  return {
    schemaVersion: 1,
    batchId: randomUUID(),
    cellId: randomUUID(),
    attempt: 1,
    scenario: scenarios()[0],
    backend: "in-process",
    provider: "faux",
    host: "node",
    mode: "lean",
    viewer: false,
    workspace: "shared",
    lifetime: "attached",
    tokenDelayMs: 0,
    directory: path,
    output: join(path, "result.json"),
    nodeCommand: process.execPath,
  };
}
// Synthetic values exercise validation/reporting only, never performance claims.
function measured(cell: CellSpec): BenchResult {
  const one = { n: 1, p50: 1, p95: 1, p99: 1, max: 1 };
  return {
    schemaVersion: 1,
    cellId: cell.cellId,
    scenario: cell.scenario.name,
    backend: cell.backend,
    provider: cell.provider,
    host: cell.host,
    runtime: {
      node: process.version,
      pi: "fixture",
      platform: process.platform,
      architecture: process.arch,
    },
    status: "completed",
    agents: 1,
    assignments: 1,
    statuses: { completed: 1 },
    usage: { expectedAttempts: 1, measuredAttempts: 1, complete: true },
    warmup: { completed: true, milliseconds: 1 },
    spawnMs: one,
    setupMs: one,
    toolCallMs: one,
    dependentMs: null,
    dependentRequestMs: null,
    acceptanceMs: one,
    journalSyncMs: one,
    artifactSyncMs: one,
    queueMs: { fifo: one, dependency: one, capacity: one },
    restoreMs: null,
    cleanupMs: one,
    notificationLagMs: one,
    loopLagP95Ms: 1,
    loopLagP99Ms: 1,
    memoryPerAgentMB: 1,
    peakRssMB: 1,
    settledHeapDeltaMB: 1,
    settledHeapMeasured: true,
    cpuMs: 1,
    wallMs: 1,
    samples: {},
    process: null,
    io: {
      artifactBytesRead: 1,
      artifactBytesSubmitted: 1,
      journalBytes: 1,
      retainedBytes: 1,
      osReadBytes: null,
      osWriteBytes: null,
      coverage: "unit fixture",
    },
    profile: {
      reducerMs: 1,
      acceptanceReducerMs: 1,
      consumptionReducerMs: 1,
      graphValidationMs: 1,
      fullLogDeliveryMs: 1,
      projectionMs: 0,
      renderMs: 0,
      renderRequests: 0,
      navigationMs: null,
      journalFrames: 1,
      fsync: {
        "journal.sync": {
          attempts: 1,
          completed: 1,
          totalMs: 1,
          busyMs: 1,
          maxConcurrent: 1,
          distinct: one,
        },
      },
      components: {
        readyQueueMs: one,
        outboxScanMs: one,
        consumptionScanMs: one,
        consumptionEntries: 1,
        sessionValidationMs: one,
        sessionRestoreMs: one,
        sessionEntries: 1,
        skill: { freezeMs: 1, materializeMs: 1, loadMs: 1, files: 2, bytes: 1, names: ["fixture"] },
        fingerprint: {
          coldMs: 1,
          warmMs: 1,
          files: 1,
          bytes: 1,
          status: "stable",
          cleanup: "stopped",
        },
        idle: {
          samples: Array.from({ length: 4 }, (_, index) => ({
            cycle: index + 1,
            stable: true,
            resources: {},
            coverage: "runtime-active-resources",
            heapUsedMB: 1,
            rssMB: 1,
          })),
          resourcePlateau: true,
          cleanup: "closed",
          assignments: 4,
        },
      },
    },
    observations: {
      requestedMode: "lean",
      viewer: false,
      activityEvents: 0,
      committedEvents: 1,
      painted: false,
    },
    cleanup: { runtime: "closed", leasesReleased: true },
    errors: [],
  };
}

test("replacement benchmark retains the classic scale fixtures and controlled history matrix", () => {
  const workloads = scenarios();
  assert.deepEqual(
    workloads.filter((entry) => entry.name.startsWith("fanout")).map((entry) => entry.tasks.length),
    [1, 8, 32, 64],
  );
  assert.equal(workloads.find((entry) => entry.name === "scale-queue-1000")?.tasks.length, 1000);
  assert.equal(
    workloads.find((entry) => entry.name === "scale-fanin-256")?.tasks.at(-1)?.after.length,
    256,
  );
  assert.equal(workloads.find((entry) => entry.name === "scale-batches-8")?.tasks.length, 512);
  assert.equal(historySweep().length, 12);
  assert.deepEqual(historySweep([8], [128])[0].histories, 128);
  assert.throws(() => parse(["--provider", "paid-provider"]), /Invalid/);
  assert.throws(() => parse(["--lifetime", "process"]), /Invalid/);
  assert.equal(parse(["--backend", "process", "--lifetime", "surviving"]).lifetime, "surviving");
});

test(
  "explicit viewer attachment overrides the UI workload default in actual scripted execution",
  { skip: !["linux", "darwin"].includes(process.platform), timeout: 60_000 },
  async (t) => {
    const uiWorkload = scenarios().find((entry) => entry.name === "ux-8");
    assert(uiWorkload?.viewer);
    const scenario = {
      ...uiWorkload,
      tasks: [{ ...uiWorkload.tasks[0], rounds: 0 }],
      streamChars: 128,
    };
    for (const viewer of [false, true]) {
      const cell = { ...spec(await directory(t)), scenario, viewer };
      const result = await runCell(cell);
      assert.equal(result.status, "completed");
      assert.equal(result.cleanup.runtime, "closed");
      assert.equal(result.observations.viewer, viewer);
      if (viewer) {
        assert(result.profile.renderRequests > 0);
        assert.equal(result.profile.navigationMs?.n, 100);
      } else {
        assert.equal(result.profile.renderRequests, 0);
        assert.equal(result.profile.navigationMs, null);
      }
      const failures = executionFailures(cell, result);
      assert.equal(
        failures.some((message) => /viewer/.test(message)),
        false,
      );
      assert(
        executionFailures(cell, {
          ...result,
          observations: { ...result.observations, viewer: !viewer },
        }).some((message) => /viewer attachment/.test(message)),
      );
    }
  },
);

test("fsync profiling retains overlapping counts without inventing individual durations", () => {
  const observer = new Observer();
  observer.fault("artifact.sync.before");
  observer.fault("artifact.sync.before");
  observer.fault("artifact.sync.after");
  observer.fault("artifact.sync.after");
  observer.fault("artifact.directory-sync.before");
  observer.fault("artifact.directory-sync.after");
  const syncs = observer.fsync();
  assert.equal(syncs["artifact.sync"].attempts, 2);
  assert.equal(syncs["artifact.sync"].completed, 2);
  assert.equal(syncs["artifact.sync"].maxConcurrent, 2);
  assert.equal(syncs["artifact.sync"].distinct, null);
  assert(syncs["artifact.sync"].totalMs >= syncs["artifact.sync"].busyMs);
  assert.equal(syncs["artifact.directory-sync"].distinct?.n, 1);
  assert.deepEqual(observer.artifactSync, []);
  observer.fault("journal.sync.before");
  assert.equal(observer.fsync()["journal.sync"].attempts, 1);
  assert.equal(observer.fsync()["journal.sync"].completed, 0);
});

test("idle resource evidence rejects growth or unsettled samples after warm-up", async (t) => {
  const components = measured(spec(await directory(t))).profile.components;
  assert(components);
  const samples = components.idle.samples;
  assert.equal(resourcePlateau(samples), true);
  assert.equal(
    resourcePlateau(samples.map((sample, index) => ({ ...sample, resources: { Timeout: index } }))),
    false,
  );
  assert.equal(
    resourcePlateau(samples.map((sample, index) => ({ ...sample, stable: index !== 2 }))),
    false,
  );
});

test("measurement gates reject incomplete execution, usage, cleanup and loaded process memory", async (t) => {
  const cell = spec(await directory(t));
  const result = measured(cell);
  assert.deepEqual(executionFailures(cell, result), []);
  assert.equal(
    benchResultSchema.safeParse({ ...result, spawnMs: { ...result.spawnMs, p50: -1 } }).success,
    false,
  );
  assert(
    executionFailures(cell, { ...result, usage: { ...result.usage, complete: false } }).some(
      (error) => /usage/.test(error),
    ),
  );
  assert(
    executionFailures(cell, {
      ...result,
      cleanup: { runtime: "owner_unconfirmed", leasesReleased: false },
    }).some((error) => /cleanup/.test(error)),
  );
  assert(
    executionFailures(cell, { ...result, spawnMs: null }).some((error) => /coverage/.test(error)),
  );
  assert(
    executionFailures(
      { ...cell, backend: "process" },
      { ...result, backend: "process", process: null },
    ).some((error) => /RSS/.test(error)),
  );
  const budgets = [{ scenario: cell.scenario.name, metric: "spawnMs.p50", max: 10 }];
  assert.deepEqual(
    overBudget({ ...result, spawnMs: { n: 1, p50: 20, p95: 20, p99: 20, max: 20 } }, budgets),
    [],
  );
  assert.equal(
    overBudget({ ...result, spawnMs: { n: 1, p50: 20.001, p95: 21, p99: 21, max: 21 } }, budgets)
      .length,
    1,
  );
});

test("Darwin filesystem names require one unambiguous local filesystem row", () => {
  const filesystem = {
    name: "/dev/disk3s5",
    type: "apfs",
    "mounted-on": "/System/Volumes/Data",
    "total-blocks": "1942708792",
  };
  const output = (rows: unknown[]) =>
    JSON.stringify({ "storage-system-information": { filesystem: rows } });
  assert.deepEqual(parseDarwinFilesystem(output([filesystem])), {
    name: "apfs",
    deviceNode: "/dev/disk3s5",
    mountPoint: "/System/Volumes/Data",
  });
  assert.equal(parseDarwinFilesystem(output([{ ...filesystem, type: "hfs" }])).name, "hfs");
  assert.equal(
    parseDarwinFilesystem(output([{ ...filesystem, name: "/dev/disk1s5s1" }])).deviceNode,
    "/dev/disk1s5s1",
  );
  for (const invalid of [
    "not JSON",
    "{}",
    output([]),
    output([filesystem, filesystem]),
    output([{ ...filesystem, type: undefined }]),
    output([{ ...filesystem, type: 26 }]),
    output([{ ...filesystem, type: "" }]),
    output([{ ...filesystem, name: "apfs" }]),
    output([{ ...filesystem, name: "/dev/disk3s5\\nforged" }]),
    output([{ ...filesystem, "mounted-on": "relative" }]),
  ])
    assert.throws(() => parseDarwinFilesystem(invalid));
});

test("Darwin APFS CI profile changes only four latency thresholds", async (t) => {
  const filesystemName = {
    status: "observed",
    method: "darwin-df-libxo-v1",
    name: "apfs",
    directory: "/private/var/example.cells",
    device: "16777233",
    deviceNode: "/dev/disk3s5",
    mountPoint: "/System/Volumes/Data",
  };
  const storage = {
    status: "observed",
    directory: filesystemName.directory,
    filesystemType: "0x1a",
    blockSize: "4096",
    device: filesystemName.device,
    filesystemName,
  };
  const context = { ci: true, backend: "in-process" as const, platform: "darwin", storage };
  const selected = selectBudgets(budgetConfiguration, context);
  assert.equal(selected.profile, "darwin-apfs-v1");
  const changed = selected.budgets.filter(
    (budget, index) => budget.max !== budgetConfiguration.budgets[index].max,
  );
  assert.deepEqual(changed, [
    { scenario: "fanout-1", metric: "spawnMs.p50", max: 75 },
    { scenario: "fanout-8", metric: "spawnMs.p50", max: 225 },
    { scenario: "fanout-32", metric: "setupMs.p50", max: 175 },
    { scenario: "fanout-64", metric: "setupMs.p50", max: 225 },
  ]);
  assert.deepEqual(
    selected.budgets.map(({ scenario, metric }) => ({ scenario, metric })),
    budgetConfiguration.budgets.map(({ scenario, metric }) => ({ scenario, metric })),
  );
  assert.deepEqual(
    selected.budgets.filter((budget) => !changed.includes(budget)),
    [
      { scenario: "fanout-8", metric: "memoryPerAgentMB", max: 5 },
      { scenario: "fanout-32", metric: "memoryPerAgentMB", max: 5 },
      { scenario: "stress-64", metric: "dependentMs.p99", max: 30 },
      { scenario: "ux-8", metric: "loopLagP99Ms", max: 20 },
    ],
  );
  const original = measured(spec(await directory(t)));
  for (const budget of changed) {
    const resultWith = (value: number): BenchResult => {
      const sample = { n: 1, p50: value, p95: value, p99: value, max: value };
      return {
        ...original,
        scenario: budget.scenario,
        ...(budget.metric === "spawnMs.p50" ? { spawnMs: sample } : { setupMs: sample }),
      };
    };
    assert.deepEqual(overBudget(resultWith(budget.max * 2), selected.budgets), []);
    assert.equal(overBudget(resultWith(budget.max * 2 + 0.001), selected.budgets).length, 1);
  }
  for (const platform of ["linux", "win32"])
    assert.deepEqual(selectBudgets(budgetConfiguration, { ...context, platform }), {
      profile: "default-v1",
      budgets: budgetConfiguration.budgets,
    });
  for (const unknownStorage of [
    undefined,
    null,
    {},
    { ...storage, status: "unavailable" },
    { ...storage, filesystemName: undefined },
    { ...storage, filesystemName: { status: "unavailable", reason: "probe failed" } },
    { ...storage, filesystemName: { ...filesystemName, name: "hfs" } },
    { ...storage, filesystemName: { ...filesystemName, method: "environment-label" } },
    { ...storage, filesystemName: { ...filesystemName, directory: "/another/allocation" } },
    { ...storage, filesystemName: { ...filesystemName, device: "42" } },
    { status: "observed", filesystemType: "0x1a" },
    { ...storage, filesystemType: "unknown" },
    { ...storage, blockSize: "unknown" },
  ])
    assert.deepEqual(selectBudgets(budgetConfiguration, { ...context, storage: unknownStorage }), {
      profile: "default-v1",
      budgets: budgetConfiguration.budgets,
    });
  assert.deepEqual(
    selectBudgets(budgetConfiguration, {
      ...context,
      storage: { ...storage, filesystemType: "0x1b" },
    }),
    selected,
  );
  assert.deepEqual(selectBudgets(budgetConfiguration, { ...context, ci: false }), {
    profile: "advisory",
    budgets: [],
  });
  for (const backend of ["process", "herdr-pi"] as const)
    assert.deepEqual(selectBudgets(budgetConfiguration, { ...context, backend }), {
      profile: "advisory",
      budgets: [],
    });
  const previous = {
    schemaVersion: 1,
    measurement: "pinata-scripted-runtime-v1",
    status: "completed",
    provenance: { storage, budgetProfile: "default-v1" },
  };
  assert.match(
    comparison(previous, { provenance: { storage, budgetProfile: selected.profile } }).reasons.join(
      "; ",
    ),
    /budgetProfile/,
  );
});

test("benchmark cells and output reservations are durable before launch and never overwrite reports", async (t) => {
  const path = await directory(t);
  const output = await reserveOutput(path, join(path, "result.json"));
  const requested = spec(path);
  const { cellId: _id, directory: _directory, output: _output, ...input } = requested;
  const allocated = await allocateCell(output.directory, input);
  assert.equal(
    JSON.parse(await readFile(join(allocated.spec.directory, "status.json"), "utf8")).state,
    "allocated",
  );
  assert.equal(
    JSON.parse(await readFile(join(allocated.spec.directory, "spec.json"), "utf8")).cellId,
    allocated.spec.cellId,
  );
  const original = await readFile(output.path);
  await assert.rejects(reserveOutput(path, output.path), /EEXIST/);
  assert.deepEqual(await readFile(output.path), original);
});

test("benchmark comparisons require observed matching storage media without binding report paths", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "pinata-bench-storage-provenance-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observed = await storageProvenance(directory);
  assert.equal(observed.status, "observed");
  assert.equal(observed.directory, directory);
  assert.equal(
    observed.filesystemType,
    `0x${(await statfs(directory, { bigint: true })).type.toString(16)}`,
  );
  const storage = { ...observed, filesystemType: "0x1021994" };
  const previous = {
    schemaVersion: 1,
    measurement: "pinata-scripted-runtime-v1",
    status: "completed",
    provenance: { storage },
  };
  assert.equal(
    comparison(previous, {
      provenance: { storage: { ...storage, directory: "another-retained-path" } },
    }).comparable,
    true,
  );
  assert.match(
    comparison(previous, {
      provenance: { storage: { ...storage, filesystemType: "0x9123683e" } },
    }).reasons.join("; "),
    /storage filesystem/,
  );
  assert.equal(comparison(previous, { provenance: {} }).comparable, false);
  assert.equal(
    comparison({ ...previous, provenance: {} }, { provenance: { storage } }).comparable,
    false,
  );
});

test(
  "complete over-budget retries retain every allocated attempt and execution failures do not retry",
  { timeout: 20_000 },
  async (t) => {
    const path = await directory(t);
    const output = join(path, "retries.json");
    const expected = selectBudgets(budgetConfiguration, {
      ci: true,
      backend: "in-process",
      platform: process.platform,
      storage: await storageProvenance(path),
    });
    const startup = expected.budgets.find(
      (budget) => budget.scenario === "fanout-1" && budget.metric === "spawnMs.p50",
    );
    assert(startup);
    const effectiveLimit = startup.max * 2;
    let runs = 0;
    const code = await main(
      ["--scenario", "fanout-1", "--ci", "--out", output],
      async (cell, record) => {
        assert.equal(
          JSON.parse(await readFile(join(cell.directory, "spec.json"), "utf8")).cellId,
          cell.cellId,
        );
        assert.equal(
          JSON.parse(await readFile(join(cell.directory, "status.json"), "utf8")).state,
          "allocated",
        );
        runs++;
        record.cleanup = {
          status: "stopped",
          ownerEpoch: cell.cellId,
          identities: [],
          evidence: [],
        };
        const result = measured(cell);
        result.spawnMs = {
          n: 1,
          p50: runs === 1 ? effectiveLimit + 1 : effectiveLimit - 1,
          p95: effectiveLimit + 1,
          p99: effectiveLimit + 1,
          max: effectiveLimit + 1,
        };
        return result;
      },
    );
    assert.equal(code, 0);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.budgetFactor, 2);
    assert.equal(report.budgetProfile, expected.profile);
    assert.equal(report.provenance.budgetProfile, expected.profile);
    assert.deepEqual(report.budgets, expected.budgets);
    assert.match(
      await readFile(output.replace(/\.json$/, ".md"), "utf8"),
      new RegExp(expected.profile),
    );
    assert.equal(report.cells.length, 2);
    assert.equal(report.cells[0].performanceFailures.length, 1);
    assert.equal(report.cells[1].performanceFailures.length, 0);
    assert.equal(
      (await readdir(output + ".cells")).filter((name) => name !== "provenance-agent").length,
      2,
    );
    runs = 0;
    const failed = await main(
      ["--scenario", "fanout-1", "--ci", "--out", join(path, "failed.json")],
      async (cell, record) => {
        runs++;
        record.cleanup = {
          status: "stopped",
          ownerEpoch: cell.cellId,
          identities: [],
          evidence: [],
        };
        const result = measured(cell);
        result.usage.complete = false;
        return result;
      },
    );
    assert.equal(failed, 1);
    assert.equal(runs, 1);
  },
);

test("benchmark report reader accepts the v1 format and rejects unsupported versions", async (t) => {
  const path = join(await directory(t), "report.json");
  const report = { schemaVersion: 1, measurement: "pinata-scripted-runtime-v1" };
  await writeFile(path, JSON.stringify(report));
  assert.deepEqual(await readReport(path), { format: "runtime-v1", comparable: true, report });
  for (const schemaVersion of [2, 3, 4, 99]) {
    await writeFile(path, JSON.stringify({ ...report, schemaVersion }));
    await assert.rejects(readReport(path), /Unsupported benchmark report version/);
  }
});
