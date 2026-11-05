import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ChildMemorySampler } from "../../bench/child-memory.ts";
import {
  compareProcessReports,
  main,
  processReportFailures,
  processSeries,
  PROCESS_MEASUREMENT_VERSION,
  type ProcessReport,
} from "../../bench/process.ts";
import { terminateProcessTree } from "../../bench/process-tree.ts";
import type { ReportMeta } from "../../bench/report.ts";
import { fanout } from "../../bench/scenarios/fanout.ts";
import { summarize, type EngineRaw } from "../../bench/targets/engine-core.ts";
import { failureDiagnostics } from "../../bench/targets/engine.ts";
import { startLoopback } from "../../bench/providers/loopback.ts";
import { tempDir } from "./helpers.ts";

test("child RSS drains pending reads and samples readiness requests that overlap spawn sampling", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  let started!: () => void;
  const reading = new Promise<void>((done) => {
    started = done;
  });
  const ready = new Set<string>();
  let reads = 0;
  const sampler = new ChildMemorySampler(async () => new Map([[123, "scout-1"]]), {
    ready: () => ready,
    read: async () => {
      reads++;
      if (reads === 1) {
        started();
        await blocked;
      }
      return new Map([[123, reads === 1 ? 3 : 120]]);
    },
  });
  void sampler.sample();
  await reading;
  ready.add("scout-1");
  void sampler.sample();
  const stopping = sampler.stop();
  release();
  const result = await stopping;
  assert.equal(reads, 2);
  assert.deepEqual(result.peakRssByAgentMB, { "scout-1": 120 });
  assert.deepEqual(result.rssSamplesByAgent, { "scout-1": 2 });
  assert.deepEqual(result.readyRssSamplesByAgent, { "scout-1": 1 });
  await sampler.sample();
  assert.equal(reads, 2, "stopped sampler must not begin another OS read");
});

test("child RSS records sampling failures and ignores unreadable/nonpositive values", async () => {
  const sampler = new ChildMemorySampler(
    async () =>
      new Map([
        [1, "one"],
        [2, "two"],
        [3, "three"],
      ]),
    {
      ready: () => new Set(["one", "two", "three"]),
      read: async () =>
        new Map([
          [1, null],
          [2, 0],
          [3, NaN],
        ]),
    },
  );
  await sampler.sample();
  assert.deepEqual((await sampler.stop()).peakRssByAgentMB, {});
  const broken = new ChildMemorySampler(
    async () => {
      throw new Error("OS probe failed");
    },
    { ready: () => new Set() },
  );
  await broken.sample();
  assert.match((await broken.stop()).errors.join(), /OS probe failed/);
});

test("loaded RSS response gate waits for a post-request read without waiting for later periodic reads", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const releases: Array<() => void> = [];
  const entered: Array<() => void> = [];
  const reads = Array.from({ length: 3 }, (_, index) => ({
    started: new Promise<void>((resolve) => {
      entered[index] = resolve;
    }),
    release: new Promise<void>((resolve) => {
      releases[index] = resolve;
    }),
  }));
  const ready = new Set<string>();
  let count = 0;
  const sampler = new ChildMemorySampler(async () => new Map([[123, "scout"]]), {
    ready: () => ready,
    read: async () => {
      const index = count++;
      entered[index]!();
      await reads[index]!.release;
      return new Map([[123, index === 0 ? 3 : 150]]);
    },
  });
  sampler.start();
  t.mock.timers.tick(200);
  await reads[0]!.started;
  ready.add("scout");
  const gate = sampler.waitForReady("scout");
  t.mock.timers.tick(400); // A slow pre-ready Windows probe overlaps the request.
  releases[0]!();
  await reads[1]!.started;
  t.mock.timers.tick(400); // Continuous timer demand must not extend this gate.
  releases[1]!();
  await gate;
  await reads[2]!.started;
  assert.equal(count, 3);
  assert.equal(sampler.waitForReady("scout"), gate, "only the first request waits");
  const stopping = sampler.stop();
  releases[2]!();
  const result = await stopping;
  assert.equal(result.readyRssSamplesByAgent.scout, 2);
  assert.equal(result.peakRssByAgentMB.scout, 150);
  assert(result.loadedRssWaitByAgentMs.scout >= 0);
});

test("short loopback response cannot finish before loaded RSS and its startup timestamp precedes the wait", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading!: () => void;
  const entered = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const ready = new Set<string>();
  let alive = true;
  const sampler = new ChildMemorySampler(async () => new Map([[123, "scout"]]), {
    ready: () => ready,
    read: async () => {
      reading();
      await blocked;
      return new Map([[123, alive ? 160 : null]]);
    },
  });
  const loopback = await startLoopback({
    tokenDelayMs: 0,
    responder: async ({ agent }) => {
      assert.equal(agent, "scout");
      ready.add(agent);
      await sampler.waitForReady(agent);
      return { text: "done" };
    },
  });
  t.after(async () => {
    release();
    await loopback.close();
    await sampler.stop();
  });
  let finished = false;
  const response = fetch(loopback.origin, {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "[bench:scout] short task" }] }),
  }).then(async (response) => {
    await response.text();
    finished = true;
    alive = false;
  });
  await entered;
  assert.equal(finished, false);
  const timestamp = loopback.firstRequest.get("scout");
  assert.equal(typeof timestamp, "number");
  release();
  await response;
  const sampled = await sampler.stop();
  assert.equal(sampled.readyRssSamplesByAgent.scout, 1);
  assert.equal(sampled.peakRssByAgentMB.scout, 160);
  assert.equal(loopback.firstRequest.get("scout"), timestamp);
  assert.deepEqual(loopback.errors, []);
});

test("loaded RSS waits are bounded and unreadable samples fail without retrying", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const sampler = new ChildMemorySampler(async () => new Map([[123, "scout"]]), {
    ready: () => new Set(["scout"]),
    loadedRssWaitTimeoutMs: 10,
    read: async () => {
      reads++;
      await blocked;
      return new Map([[123, null]]);
    },
  });
  await assert.rejects(sampler.waitForReady("scout"), /timed out.*10 ms/);
  release();
  const timedOut = await sampler.stop();
  assert.equal(reads, 1);
  assert.deepEqual(timedOut.readyRssSamplesByAgent, {});
  assert.match(timedOut.errors.join(), /timed out/);
  const unreadable = new ChildMemorySampler(async () => new Map([[123, "scout"]]), {
    ready: () => new Set(["scout"]),
    read: async () => new Map([[123, null]]),
  });
  await assert.rejects(unreadable.waitForReady("scout"), /sample unavailable/);
  assert.deepEqual((await unreadable.stop()).readyRssSamplesByAgent, {});
});

const scenario = fanout(2);
function raw(): EngineRaw {
  return {
    t0: 100,
    setupAt: {},
    wallMs: 80,
    startedAt: { "scout-1": 110, "scout-2": 120 },
    settledAt: { "scout-1": 170, "scout-2": 180 },
    processSpawnedAt: { "scout-1": 115, "scout-2": 125 },
    backend: "process",
    statuses: { succeeded: 2 },
    baselineRss: 10 * 1048576,
    peakRss: 20 * 1048576,
    maxRunning: 2,
    settledHeapDeltaMB: 1,
    lagP99Ms: 1,
    cpuMs: 5,
    host: "node test",
    errors: [],
    childMemory: {
      peakRssByAgentMB: { "scout-1": 100, "scout-2": 120 },
      rssSamplesByAgent: { "scout-1": 2, "scout-2": 3 },
      readyRssSamplesByAgent: { "scout-1": 1, "scout-2": 2 },
      loadedRssWaitByAgentMs: { "scout-1": 10, "scout-2": 20 },
      loadedRssWaitTimeoutMs: 5000,
      sampleIntervalMs: 200,
      errors: [],
    },
  };
}
const result = () => summarize(scenario, raw(), { "scout-1": 130, "scout-2": 145 }, "loopback");

test("process summary preserves independent startup observations and complete child RSS attribution", () => {
  const summary = result();
  assert.deepEqual(summary.samples?.spawnMs, { "scout-1": 20, "scout-2": 25 });
  assert.deepEqual(summary.process?.startupByAgentMs, { "scout-1": 15, "scout-2": 20 });
  assert.equal(summary.memoryPerAgentMB, 110);
  assert.equal(summary.peakRssMB, 20, "host RSS must remain separately identified");
  assert.deepEqual(summary.process?.loadedRssWaitByAgentMs, { "scout-1": 10, "scout-2": 20 });
  assert.equal(summary.process?.loadedRssWaitTimeoutMs, 5000);
  assert.equal(summary.wallMs, 80, "measurement waits must not be subtracted from wall time");
  assert.match(summary.notes!.join(" "), /first-request startup timestamps precede the wait/);
  for (const changed of [
    { childMemory: undefined },
    { childMemory: { ...raw().childMemory!, peakRssByAgentMB: { "scout-1": 100 } } },
    { childMemory: { ...raw().childMemory!, readyRssSamplesByAgent: { "scout-1": 1 } } },
  ]) {
    const incomplete = summarize(
      scenario,
      { ...raw(), ...changed },
      { "scout-1": 130, "scout-2": 145 },
      "loopback",
    );
    assert.equal(incomplete.memoryPerAgentMB, null);
    assert.equal(incomplete.process?.childPeakRssMB, null);
    assert(incomplete.process!.missingRssAgents.includes("scout-2"));
  }
});

function meta(): ReportMeta {
  return {
    kind: "process",
    provider: "loopback",
    host: "node",
    backend: "process",
    mode: "lean",
    tokenDelayMs: 1,
    scenarios: [scenario.name],
    date: "2026-11-05",
    startedAt: "2026-11-05T12:00:00.000Z",
    runId: "00000000-0000-0000-0000-000000000001",
    source: {
      commit: "a".repeat(40),
      branch: "test",
      dirty: false,
      lockfileSha256: "lock",
      workingTreeSha256: "tree",
    },
    os: "linux",
    release: "test-os",
    arch: "x64",
    cpus: 4,
    memoryGB: 8,
    machine: { hostname: "test", cpuModel: "fixture cpu", memoryBytes: 8 * 1024 ** 3 },
    node: "v24.19.0",
    v8: "test-v8",
    executable: "/node",
    pi: "1.1.0",
    piCommand: ["pi"],
    piRuntime: {
      kind: "native",
      executableSha256: "c".repeat(64),
      scriptSha256: null,
      interpreterVersion: null,
    },
    processPiCommand: ["pi"],
    processPiRuntime: {
      kind: "native",
      executableSha256: "c".repeat(64),
      scriptSha256: null,
      interpreterVersion: null,
    },
    runnerGcExposed: true,
    instrumentation: { gc: true, sampler: true, loopLag: true, trace: false },
    workloadSha256: "aggregate",
    ciRun: {
      provider: null,
      runId: null,
      attempt: null,
      job: null,
      imageOS: null,
      imageVersion: null,
    },
  };
}

function report(): ProcessReport {
  const output: ProcessReport = {
    schemaVersion: 1,
    measurementVersion: PROCESS_MEASUREMENT_VERSION,
    meta: meta(),
    repeat: 3,
    workload: [scenario],
    trials: Array.from({ length: 3 }, (_, index) => ({
      repetition: index + 1,
      scenario: scenario.name,
      reportPath: `/fixture/${index}.json`,
      exitCode: 0,
      timedOut: false,
      report: {
        schemaVersion: 1,
        meta: { ...meta(), kind: "engine", workloadSha256: "scenario" },
        results: [result()],
        validation: { passed: true, failures: [] },
      },
    })),
    series: [],
    validation: { passed: true, failures: [] },
    comparison: { status: "not-requested", advisory: true, issues: [], changes: [] },
  };
  output.series = processSeries(output);
  return output;
}

test("repeated process comparison retains every trial and reports large changes without a performance gate", () => {
  const baseline = report();
  const current = report();
  for (const trial of current.trials) trial.report!.results[0].wallMs *= 20;
  assert.deepEqual(processReportFailures(current), []);
  const comparison = compareProcessReports(current, baseline);
  assert.equal(comparison.status, "compared");
  assert.equal(comparison.advisory, true);
  assert.equal(
    comparison.changes.find((change) => change.metric === "wallMs")?.changePercent,
    1900,
  );
  assert.deepEqual(
    processSeries(current).find((series) => series.metric === "wallMs")?.samples,
    [1600, 1600, 1600],
  );
});

test("process baselines reject incomplete, mixed, missing, mismatched and malformed evidence", () => {
  const mutations: Array<(report: ProcessReport) => void> = [
    (report) => {
      report.trials.pop();
    },
    (report) => {
      report.trials[1].repetition = 1;
    },
    (report) => {
      report.trials[0].exitCode = 1;
    },
    (report) => {
      report.trials[0].report!.meta.node = "v99";
    },
    (report) => {
      report.meta.machine.cpuModel = "other cpu";
    },
    (report) => {
      report.meta.tokenDelayMs = 5;
    },
    (report) => {
      report.meta.source.workingTreeSha256 = null;
    },
    (report) => {
      report.measurementVersion = 999;
    },
    (report) => {
      report.measurementVersion = 1;
    },
    (report) => {
      report.trials[0].report!.results[0].process!.loadedRssWaitByAgentMs = {};
    },
    (report) => {
      report.trials[0].report!.results[0].process = undefined;
    },
    (report) => {
      report.trials[0].report!.results[0].process!.readyRssSamplesByAgent = {};
    },
    (report) => {
      report.workload = [{ name: scenario.name }] as typeof report.workload;
    },
  ];
  for (const mutate of mutations) {
    const baseline = report();
    mutate(baseline);
    const comparison = compareProcessReports(report(), baseline);
    assert.equal(comparison.status, "incomparable");
    assert(comparison.issues.length);
    assert.deepEqual(comparison.changes, []);
  }
  assert.equal(
    compareProcessReports(report(), null as unknown as ProcessReport).status,
    "incomparable",
  );
});

test("failed repeated trials are all saved and unavailable aggregate statistics stay null", async (t) => {
  const dir = await tempDir(t, "pinata-process-evidence-");
  const output = join(dir, "failed.json");
  let calls = 0;
  const code = await main(
    ["--repeat", "3", "--scenario", "fanout-1", "--out", output],
    async (scenario, repetition, reportPath) => {
      calls++;
      return {
        repetition,
        scenario: scenario.name,
        reportPath,
        exitCode: 1,
        timedOut: false,
        report: null,
        stderrTail: "fixture failed",
      };
    },
  );
  assert.equal(code, 1);
  assert.equal(calls, 3);
  const saved: ProcessReport = JSON.parse(await readFile(output, "utf8"));
  assert.equal(saved.trials.length, 3);
  assert.equal(saved.validation.passed, false);
  assert(saved.series.every((series) => series.summary === null));
  assert.match(await readFile(output.replace(/json$/, "md"), "utf8"), /incomplete/);
  await assert.rejects(main(["--repeat", "1"]), /3 to 100/);
  await assert.rejects(main(["--timeout-ms", "0"]), /timeout/);
  await assert.rejects(main(["--timeout-ms", "2147483648"]), /timeout/);
  await assert.rejects(main(["--out", "process-output.json"]), /git-ignored/);
});

test("failure diagnostics retain bounded log tails before fixture cleanup", async (t) => {
  const dir = await tempDir(t, "pinata-bench-diagnostics-");
  await mkdir(join(dir, scenario.name), { recursive: true });
  await writeFile(join(dir, scenario.name, "events.jsonl"), "x".repeat(20_000) + "failure-end");
  const diagnostics = await failureDiagnostics(dir, scenario);
  assert.equal(diagnostics.length, 1);
  assert.equal(Buffer.byteLength(diagnostics[0].tail), 4096);
  assert(diagnostics[0].tail.endsWith("failure-end"));
});

test(
  "timeout cleanup stops detached descendant process groups",
  { skip: process.platform === "win32" },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { spawn } from 'node:child_process';
    const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    console.log(nested.pid);
    setInterval(() => {}, 1000);
  `,
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let nestedPid = 0;
    t.after(() => {
      for (const pid of [nestedPid, child.pid!])
        if (pid)
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already gone */
          }
    });
    const exited = new Promise<void>((done) => child.once("close", () => done()));
    nestedPid = await new Promise<number>((done) =>
      child.stdout.once("data", (data: Buffer) => done(Number(data.toString().trim()))),
    );
    assert(nestedPid > 0);
    await terminateProcessTree(child.pid!);
    await exited;
    // Linux may briefly retain an orphan zombie until its init process reaps it.
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${nestedPid}/status`, "utf8").catch(() => "");
      assert(status === "" || /^State:\s+Z/m.test(status), "detached child must have stopped");
    } else {
      assert.throws(() => process.kill(nestedPid, 0), { code: "ESRCH" });
    }
  },
);
