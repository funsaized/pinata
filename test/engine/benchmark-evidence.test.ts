import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Scenario, ScenarioResult } from "../../bench/lib.ts";
import {
  collectProvenance,
  comparisonIssues,
  reportFilename,
  reserveReport,
  resolvePiRuntime,
} from "../../bench/report.ts";
import { executionFailures, main, scenarios } from "../../bench/run.ts";
import { main as viewer, viewerVariants } from "../../bench/viewer.ts";
import { tempDir } from "./helpers.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const stats = (n: number) => ({ n, p50: 1, p95: 2, p99: 3, max: 3 });
const scenario = scenarios().find((s) => s.name === "fanout-8")!;
function result(s: Scenario): ScenarioResult {
  return {
    scenario: s.name,
    target: "engine",
    provider: "faux",
    host: "node",
    agents: s.tasks.length,
    statuses: { succeeded: s.tasks.length },
    spawnMs: stats(s.tasks.length),
    setupMs: stats(s.tasks.length),
    toolCallMs: stats(s.tasks.length),
    dependentMs: null,
    dependentRequestMs: null,
    memoryPerAgentMB: 1,
    peakRssMB: 20,
    loopLagP99Ms: 1,
    cpuMs: 2,
    wallMs: 3,
  };
}
const provenance = () =>
  collectProvenance(ROOT, {
    kind: "engine",
    provider: "faux",
    host: "node",
    backend: "in-process",
    mode: "lean",
    tokenDelayMs: 1,
    scenarios: [scenario.name],
    workload: scenario,
  });

function processResult(): ScenarioResult {
  const byAgent = Object.fromEntries(scenario.tasks.map((task) => [task.id, 100]));
  return {
    ...result(scenario),
    memoryPerAgentMB: 100,
    process: {
      startupMs: stats(scenario.tasks.length),
      startupByAgentMs: byAgent,
      childPeakRssMB: stats(scenario.tasks.length),
      peakRssByAgentMB: byAgent,
      rssSamplesByAgent: byAgent,
      readyRssSamplesByAgent: byAgent,
      missingRssAgents: [],
      sampleIntervalMs: 200,
      errors: [],
    },
  };
}

test("default evidence names distinguish simultaneous runs and identify the runtime", async (t) => {
  const dir = await tempDir(t);
  const meta = await provenance();
  assert.match(meta.source.workingTreeSha256!, /^[a-f0-9]{64}$/);
  const second = { ...meta, runId: randomUUID() };
  assert.notEqual(reportFilename(meta), reportFilename(second));
  const reports = await Promise.all([reserveReport(dir, meta), reserveReport(dir, second)]);
  try {
    for (const output of reports) {
      assert(output.path.includes(meta.source.commit!.slice(0, 12)));
      assert(output.path.includes(`${meta.os}-${meta.arch}`));
      assert(output.path.includes(`node-${meta.node}`));
      assert(output.path.includes("node_in-process_faux_lean"));
      await output.write({ run: output.path }, "summary\n");
      assert.equal(JSON.parse(await readFile(output.path, "utf8")).run, output.path);
      assert.equal(await readFile(output.summaryPath, "utf8"), "summary\n");
    }
  } finally {
    await Promise.all(reports.map((output) => output.close()));
  }
});

test("explicit output and summary collisions are rejected before a workload runs", async (t) => {
  const dir = await tempDir(t);
  for (const companion of [false, true]) {
    const file = join(dir, `${companion}.json`);
    const existing = companion ? file.replace(/\.json$/, ".md") : file;
    await writeFile(existing, "previous evidence\n");
    let ran = false;
    await assert.rejects(
      main(["--scenario", scenario.name, "--out", file], async () => {
        ran = true;
        return result(scenario);
      }),
      /Refusing to overwrite benchmark (report|summary)/,
    );
    assert.equal(ran, false);
    assert.equal(await readFile(existing, "utf8"), "previous evidence\n");
    if (companion) await assert.rejects(readFile(file), { code: "ENOENT" });
  }
});

test("exclusive reservation rejects concurrent writers; checkpoints replace complete JSON", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "report.json");
  const meta = await provenance();
  const writers = await Promise.allSettled([
    reserveReport(dir, meta, file),
    reserveReport(dir, meta, file),
  ]);
  assert.equal(writers.filter((r) => r.status === "fulfilled").length, 1);
  const writer = writers.find((r) => r.status === "fulfilled")!;
  assert.equal(writer.status, "fulfilled");
  if (writer.status !== "fulfilled") return;
  try {
    await writer.value.write({ large: "x".repeat(100_000) }, "long summary");
    await writer.value.write({ passed: false }, "short\n");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { passed: false });
    assert.equal(await readFile(writer.value.summaryPath, "utf8"), "short\n");
    assert.deepEqual((await readdir(dir)).sort(), ["report.json", "report.md"]);
  } finally {
    await writer.value.close();
  }
});

test("a thrown workload retains its checkpoint, stack, validation and readable summary", async (t) => {
  const file = join(await tempDir(t), "failure.json");
  const code = await main(["--scenario", scenario.name, "--out", file], async () => {
    const pending = JSON.parse(await readFile(file, "utf8"));
    assert.equal(pending.progress.state, "running");
    assert.equal(pending.progress.currentScenario, scenario.name);
    assert.equal(pending.validation, null);
    throw new Error("synthetic provider disconnected");
  });
  assert.equal(code, 1);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.progress.state, "failed");
  assert.equal(saved.validation.passed, false);
  assert.equal(saved.attempts[scenario.name].length, 1);
  assert.match(saved.diagnostics[0].stack, /synthetic provider disconnected/);
  const summary = await readFile(file.replace(/\.json$/, ".md"), "utf8");
  assert.match(summary, /Engine benchmark: FAIL/);
  assert.match(summary, /synthetic provider disconnected/);
});

test("process --ci checks execution without applying in-process timing or memory budgets", async (t) => {
  const previous = process.env.BENCH_BACKEND;
  t.after(() => {
    if (previous === undefined) delete process.env.BENCH_BACKEND;
    else process.env.BENCH_BACKEND = previous;
  });
  const dir = await tempDir(t);
  for (const backend of ["process", "herdr-pi"]) {
    process.env.BENCH_BACKEND = backend;
    let calls = 0;
    const file = join(dir, `${backend}.json`);
    assert.equal(
      await main(["--ci", "--scenario", scenario.name, "--out", file], async () => {
        calls++;
        return { ...processResult(), spawnMs: { ...stats(8), p50: 1000 } };
      }),
      0,
    );
    assert.equal(calls, 1);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(saved.meta.budgets, []);
    assert.equal(saved.meta.policy.performance, "advisory");
    assert.equal(saved.meta.policy.retries, 0);
  }
  process.env.BENCH_BACKEND = "process";
  const file = join(dir, "incomplete.json");
  assert.equal(
    await main(["--ci", "--scenario", scenario.name, "--out", file], async () => ({
      ...processResult(),
      statuses: { succeeded: 7 },
    })),
    1,
  );
});

test("process measurement validation requires coverage of every child's loaded RSS and startup", () => {
  const complete = processResult();
  assert.deepEqual(executionFailures(scenario, complete, [], "process"), []);
  for (const changes of [
    { startupMs: null },
    { childPeakRssMB: null },
    { startupByAgentMs: {} },
    { peakRssByAgentMB: {} },
    { rssSamplesByAgent: {} },
    { readyRssSamplesByAgent: {} },
    { missingRssAgents: [scenario.tasks[0].id] },
    { errors: ["ps failed"] },
  ]) {
    assert(
      executionFailures(
        scenario,
        { ...complete, process: { ...complete.process!, ...changes } },
        [],
        "process",
      ).length,
    );
  }
});

test("comparison allows different commits but rejects incompatible or unknown evidence", async () => {
  const meta = {
    ...(await provenance()),
    pi: "fixture-pi",
    piRuntime: {
      kind: "native" as const,
      executableSha256: "c".repeat(64),
      scriptSha256: null,
      interpreterVersion: null,
    },
  };
  const other = structuredClone(meta);
  other.source.commit = "a".repeat(40);
  other.source.workingTreeSha256 = "b".repeat(64);
  other.runId = randomUUID();
  assert.deepEqual(comparisonIssues(meta, other), []);
  for (const changes of [
    { backend: "process" },
    { host: "pi" },
    { node: "v99.0.0" },
    { workloadSha256: "changed" },
    { runnerGcExposed: !meta.runnerGcExposed },
    { instrumentation: { ...meta.instrumentation, gc: !meta.instrumentation.gc } },
    { machine: { ...meta.machine, cpuModel: "another CPU" } },
    { source: { ...meta.source, lockfileSha256: "different" } },
    { source: { ...meta.source, workingTreeSha256: null } },
    { pi: "unavailable" },
    { piRuntime: undefined },
    { piRuntime: { kind: "unknown" } },
  ])
    assert(comparisonIssues(meta, { ...other, ...changes }).length);
  assert(comparisonIssues({}, {}).length);
});

test("Pi runtime identity distinguishes native from Node CLI and follows file contents across paths", async (t) => {
  const dir = await tempDir(t);
  const native = join(dir, "pi-native");
  // A binary-header fixture is enough to test identity without launching a real Pi.
  await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]), { mode: 0o755 });
  const relocated = join(dir, "relocated-pi");
  await copyFile(native, relocated);
  const script = join(dir, "cli.js");
  await writeFile(script, '#!/usr/bin/env node\nconsole.log("1.1.0");\n', { mode: 0o755 });
  const nativeIdentity = await resolvePiRuntime([native]);
  const jsIdentity = await resolvePiRuntime([process.execPath, script]);
  assert.equal(nativeIdentity.kind, "native");
  assert.equal(jsIdentity.kind, "node-script");
  assert.equal(jsIdentity.interpreterVersion, process.version);
  assert.deepEqual(await resolvePiRuntime([relocated]), nativeIdentity);
  const meta = { ...(await provenance()), pi: "1.1.0", piRuntime: nativeIdentity };
  assert.deepEqual(
    comparisonIssues(meta, {
      ...meta,
      piCommand: [relocated],
      piRuntime: await resolvePiRuntime([relocated]),
    }),
    [],
  );
  assert(comparisonIssues(meta, { ...meta, piRuntime: jsIdentity }).includes("piRuntime differs"));
  const changed = join(dir, "changed.js");
  await copyFile(script, changed);
  assert.deepEqual(await resolvePiRuntime([process.execPath, changed]), jsIdentity);
  await writeFile(changed, 'console.log("different CLI, same version");\n');
  assert.notDeepEqual(await resolvePiRuntime([process.execPath, changed]), jsIdentity);
});

test(
  "PATH Pi symlinks identify the real file and the interpreter that PATH selects",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await tempDir(t);
    const bin = join(dir, "bin");
    await mkdir(bin);
    const script = join(dir, "selected-cli.js");
    await writeFile(script, '#!/usr/bin/env node\nconsole.log("1.1.0");\n', { mode: 0o755 });
    await symlink(script, join(bin, "pi"));
    await symlink(process.execPath, join(bin, "node"));
    const env = { ...process.env, PATH: bin };
    const explicit = await resolvePiRuntime([process.execPath, script], env);
    assert.deepEqual(await resolvePiRuntime(["pi"], env), explicit);
    const native = join(dir, "native");
    await writeFile(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]), { mode: 0o755 });
    await symlink(native, join(bin, "pi-native"));
    assert.deepEqual(
      await resolvePiRuntime(["pi-native"], env),
      await resolvePiRuntime([native], env),
    );
    const missing = await resolvePiRuntime(["absent-pi"], env);
    assert.equal(missing.kind, "unknown");
    const shell = join(bin, "wrapper");
    await writeFile(shell, '#!/bin/sh\nexec node "$@"\n', { mode: 0o755 });
    assert.equal((await resolvePiRuntime([shell], env)).kind, "unknown");
    assert.equal((await resolvePiRuntime([shell, script], env)).kind, "unknown");

    const previous = process.env.PINATA_PI;
    const previousPath = process.env.PATH;
    t.after(() => {
      if (previous === undefined) delete process.env.PINATA_PI;
      else process.env.PINATA_PI = previous;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    });
    process.env.PINATA_PI = script;
    process.env.PATH = dir; // Explicit host Node still works; the child cannot resolve PATH node.
    const meta = await collectProvenance(ROOT, {
      kind: "engine",
      provider: "loopback",
      host: "node",
      backend: "process",
      mode: "lean",
      scenarios: [scenario.name],
    });
    assert.equal(meta.piRuntime.kind, "node-script");
    assert.equal(meta.processPiRuntime?.kind, "unknown");
    assert.deepEqual(meta.processPiCommand, ["node", script]);
    assert(comparisonIssues(meta, meta).includes("processPiRuntime is unknown"));
  },
);

test("unknown and historical Pi runtime identity never compare, even with matching version strings", async () => {
  const meta = {
    ...(await provenance()),
    pi: "1.1.0",
    piRuntime: await resolvePiRuntime(["/no/such/pi-runtime"]),
  };
  assert(comparisonIssues(meta, meta).includes("piRuntime is unknown"));
  assert(
    comparisonIssues({ ...meta, piRuntime: undefined }, { ...meta, piRuntime: undefined }).includes(
      "piRuntime is unknown",
    ),
  );
  const native = {
    kind: "native" as const,
    executableSha256: "c".repeat(64),
    scriptSha256: null,
    interpreterVersion: null,
  };
  const processMeta = { ...meta, backend: "process", piRuntime: native, processPiRuntime: native };
  assert.deepEqual(comparisonIssues(processMeta, processMeta), []);
  assert(
    comparisonIssues(processMeta, {
      ...processMeta,
      processPiRuntime: { ...native, executableSha256: "d".repeat(64) },
    }).includes("processPiRuntime differs"),
  );
});

test(
  "viewer retains raw samples and prior variants when a later runtime fails",
  { skip: process.platform === "win32" },
  async (t) => {
    const file = join(await tempDir(t), "viewer.json");
    assert.equal(
      await viewer(["--runs", "2", "--out", file], async (_runs, record) => {
        await record(viewerVariants[0].name, { startupMs: 10, rssMB: 20 });
        await record(viewerVariants[0].name, { startupMs: 12, rssMB: 24 });
        const saved = JSON.parse(await readFile(file, "utf8"));
        assert.equal(saved.rawSamples[viewerVariants[0].name].length, 2);
        throw new Error("second runtime failed to start");
      }),
      1,
    );
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.validation.passed, false);
    assert.equal(saved.progress.state, "failed");
    assert.equal(saved.results[viewerVariants[0].name].samples, 2);
    assert.match(saved.diagnostics[0].message, /second runtime failed/);
    assert.match(await readFile(file.replace(/\.json$/, ".md"), "utf8"), /different feature sets/);
  },
);

test("viewer rejects malformed run counts and cannot pass with missing or invalid samples", async (t) => {
  for (const runs of ["0", "-1", "1.5", "Infinity", "typo"])
    await assert.rejects(viewer(["--runs", runs]), /positive integer/);
  await assert.rejects(viewer(["--unknown"]), /Unknown option/);
  if (process.platform === "win32") return;
  const dir = await tempDir(t);
  assert.equal(
    await viewer(["--runs", "1", "--out", join(dir, "missing.json")], async () => {}),
    1,
  );
  assert.equal(
    await viewer(["--runs", "1", "--out", join(dir, "invalid.json")], async (_runs, record) => {
      await record(viewerVariants[0].name, { startupMs: NaN, rssMB: 20 });
    }),
    1,
  );
});
