import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ChildMemorySampler } from "../../bench/child-memory.ts";
import {
  compareProcessReports,
  main,
  processReportFailures,
  processSeries,
  runTrial,
  type ProcessReport,
} from "../../bench/process.ts";
import { terminateProcessTree } from "../../bench/process-tree.ts";
import type { ReportMeta } from "../../bench/report.ts";
import { fanout } from "../../bench/scenarios/fanout.ts";
import { summarize, type EngineRaw } from "../../bench/targets/engine-core.ts";
import { failureDiagnostics } from "../../bench/targets/engine.ts";
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
      sampleIntervalMs: 200,
      rssMethod: "linux-proc-status-v1",
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
    measurementVersion: 2,
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
      report.measurementVersion = 1; // Historical v1 evidence is not a v2 baseline.
    },
    (report) => {
      report.trials[0].report!.results[0].process!.rssMethod =
        "windows-persistent-dotnet-working-set-v1";
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
  for (const trial of saved.trials) {
    const checkpoint = JSON.parse(await readFile(`${trial.reportPath}.status.json`, "utf8"));
    assert.equal(checkpoint.state, "finished");
    assert.equal(checkpoint.validation.passed, false);
    assert.deepEqual(checkpoint.trial, trial);
  }
  await assert.rejects(main(["--repeat", "1"]), /3 to 100/);
  await assert.rejects(main(["--out", "process-output.json"]), /git-ignored/);
});

const lifecycleFixture = fileURLToPath(
  new URL("./fixtures/benchmark-lifecycle.mjs", import.meta.url),
);

test("a normally completed host retains valid measurements, output and an independent passing checkpoint", async (t) => {
  const dir = await tempDir(t, "pinata-process-completed-");
  const reportPath = join(dir, "trial.json");
  const expected = report().trials[0].report;
  await writeFile(reportPath, JSON.stringify(expected));
  const trial = await runTrial(
    scenario,
    1,
    reportPath,
    {
      timeoutMs: 10_000,
      tokenDelayMs: 0,
      mode: "lean",
    },
    {
      launch: () =>
        spawn(process.execPath, ["-e", "console.log('completed'); console.error('diagnostic')"], {
          stdio: ["ignore", "pipe", "pipe"],
        }),
      terminate: async () => {
        assert.fail("completed host must not need cleanup");
      },
    },
  );
  assert.equal(trial.exitCode, 0);
  assert.equal(trial.timedOut, false);
  assert.equal(trial.error, undefined);
  assert.deepEqual(trial.report, expected);
  assert.match(trial.stdoutTail!, /completed/);
  assert.match(trial.stderrTail!, /diagnostic/);
  const checkpoint = JSON.parse(await readFile(`${reportPath}.status.json`, "utf8"));
  assert.equal(checkpoint.state, "finished");
  assert.equal(checkpoint.validation.passed, true);
  assert.deepEqual(checkpoint.trial, trial);
});

async function lifecycleFixtureRun(mode: string, directory: string) {
  const child = spawn(process.execPath, [lifecycleFixture, mode, directory], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk;
  });
  let exceeded = false;
  const guard = setTimeout(() => {
    exceeded = true;
    child.kill("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
  }, 10_000);
  let completed: { code: number | null; stdout: string; stderr: string } | undefined;
  const failures: unknown[] = [];
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once("close", done);
      child.once("error", reject);
    });
    assert.equal(exceeded, false, `Coordinator must exit naturally: ${stderr}`);
    completed = { code, stdout, stderr };
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(guard);
    try {
      const pids: number[] = JSON.parse(
        await readFile(join(directory, "pids.json"), "utf8").catch(() => "[]"),
      );
      // Reparented fixture children are outside the cleanup guarantee. Attempt
      // every owned fixture cleanup, retaining both test and cleanup failures.
      for (const pid of pids.reverse()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(error);
        }
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Lifecycle fixture or cleanup failed");
  return completed!;
}

test("an exited host with inherited output pipes cannot hold the trial or coordinator open", async (t) => {
  const dir = await tempDir(t, "pinata-process-orphan-");
  const completed = await lifecycleFixtureRun("exit-held-pipes", dir);
  assert.equal(completed.code, 0, completed.stderr);
  const { trial, cleanupCalls } = JSON.parse(completed.stdout);
  assert.equal(trial.exitCode, 0);
  assert.equal(
    trial.timedOut,
    false,
    "host exit must trigger draining before the 30s trial deadline",
  );
  assert.equal(cleanupCalls, 0, "an observed exited host PID must never be signalled");
  assert.match(trial.error, /output did not close/);
  assert.match(trial.error, /descendant cleanup cannot be confirmed/);
  const checkpoint = JSON.parse(await readFile(`${trial.reportPath}.status.json`, "utf8"));
  assert.equal(checkpoint.state, "finished");
  assert.equal(checkpoint.validation.passed, false);
  assert.deepEqual(checkpoint.trial, trial);
});

for (const mode of ["timeout", "cleanup-reject", "cleanup-hang"]) {
  test(`process trial ${mode} is bounded, checkpointed and cannot retain coordinator handles`, async (t) => {
    const dir = await tempDir(t, `pinata-process-${mode}-`);
    const completed = await lifecycleFixtureRun(mode, dir);
    assert.equal(completed.code, 0, completed.stderr);
    const { trial, cleanupCalls } = JSON.parse(completed.stdout);
    assert.equal(trial.timedOut, true);
    assert.match(trial.error, /exceeded 100ms timeout/);
    if (mode !== "timeout") assert.equal(cleanupCalls, 1);
    if (mode === "cleanup-reject") assert.match(trial.error, /fixture cleanup failed/);
    if (mode === "cleanup-hang") {
      assert.match(trial.error, /cleanup exceeded 100ms/);
      assert.equal(await readFile(join(dir, "aborted.txt"), "utf8"), "aborted");
    }
    const checkpoint = JSON.parse(await readFile(`${trial.reportPath}.status.json`, "utf8"));
    assert.equal(checkpoint.state, "finished");
    assert.equal(checkpoint.validation.passed, false);
    assert.deepEqual(checkpoint.trial, trial);
  });
}

test("aborting a cleanup utility closes inherited pipes and lets its coordinator exit", async (t) => {
  const dir = await tempDir(t, "pinata-cleanup-command-");
  const completed = await lifecycleFixtureRun("cleanup-command-abort", dir);
  assert.equal(completed.code, 0, completed.stderr);
  assert.match(JSON.parse(completed.stdout).error, /fixture cleanup aborted/);
});

test("host exit during cleanup cannot mutate a finished trial after its pipe drain deadline", async (t) => {
  const dir = await tempDir(t, "pinata-process-late-drain-");
  const completed = await lifecycleFixtureRun("late-drain", dir);
  assert.equal(completed.code, 0, completed.stderr);
  const { trial, cleanupCalls } = JSON.parse(completed.stdout);
  assert.equal(cleanupCalls, 1);
  assert.equal(trial.timedOut, true);
  const checkpoint = JSON.parse(await readFile(`${trial.reportPath}.status.json`, "utf8"));
  assert.deepEqual(checkpoint.trial, trial);
  assert.equal(checkpoint.validation.passed, false);
});

test("an abruptly exited collector leaves an independent incomplete trial checkpoint", async (t) => {
  const dir = await tempDir(t, "pinata-collector-exit-");
  const completed = await lifecycleFixtureRun("collector-exit", dir);
  assert.equal(completed.code, 7, completed.stderr);
  const aggregate = JSON.parse(await readFile(join(dir, "aggregate.json"), "utf8"));
  assert.equal(aggregate.trials.length, 0);
  assert.equal(aggregate.validation.passed, false);
  const trialDir = (await readdir(dir)).find((name) => name.startsWith("trials-"))!;
  const checkpoint = JSON.parse(
    await readFile(join(dir, trialDir, "1-fanout-1.json.status.json"), "utf8"),
  );
  assert.equal(checkpoint.state, "running");
  assert.equal(checkpoint.validation.passed, false);
  assert.equal(checkpoint.trial.repetition, 1);
  assert.equal(checkpoint.trial.exitCode, null);
  assert.equal(checkpoint.trial.report, null);
});

test("an aggregate writer failure preserves the finished failed trial independently", async (t) => {
  const dir = await tempDir(t, "pinata-aggregate-failure-");
  const output = join(dir, "aggregate.json");
  await assert.rejects(
    main(["--repeat", "3", "--scenario", "fanout-1", "--out", output], async () => {
      await rm(output);
      await mkdir(output);
      throw new Error("fixture collector failed");
    }),
  );
  const trialDir = (await readdir(dir)).find((name) => name.startsWith("trials-"))!;
  const checkpoint = JSON.parse(
    await readFile(join(dir, trialDir, "1-fanout-1.json.status.json"), "utf8"),
  );
  assert.equal(checkpoint.state, "finished");
  assert.equal(checkpoint.validation.passed, false);
  assert.match(checkpoint.trial.error, /fixture collector failed/);
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
    nested.once('error', (error) => {
      console.error('Nested spawn failed:', error);
      process.exit(1);
    });
    nested.once('spawn', () => process.stdout.write(String(nested.pid) + '\\n'));
    setInterval(() => {}, 1000);
  `,
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        // Machine-readable PID output must stay plain even with forced colors.
        env: { ...process.env, FORCE_COLOR: "1" },
      },
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
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    try {
      nestedPid = await new Promise<number>((resolve, reject) => {
        lines.once("line", (line) => {
          const pid = Number(line);
          if (!Number.isInteger(pid) || pid <= 0) {
            reject(new Error(`Invalid nested PID: ${JSON.stringify(line)}`));
          } else {
            resolve(pid);
          }
        });
        // Wait for close so stderr has drained before reporting a startup failure.
        child.once("close", (code, signal) => {
          reject(
            new Error(
              `Fixture closed before reporting its PID (code=${code}, signal=${signal}): ${stderr}`,
            ),
          );
        });
        child.once("error", reject);
      });
    } finally {
      lines.close();
    }
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
