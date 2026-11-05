import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import {
  runArena,
  parseAdapterResponse,
  parseAdapterConfig,
  treeManifest,
  type AdapterConfig,
  type ArenaOptions,
} from "../../arena/runner.ts";
import { runProcess } from "../../arena/process.ts";
import { comparisonWarnings, loadResults, renderReport } from "../../arena/report.ts";
import { parseArgs } from "../../arena/run.ts";
import type { AdapterResponse, ArenaTask } from "../../arena/types.ts";

const goodResponse: AdapterResponse = {
  schemaVersion: 1,
  status: "completed",
  framework: { name: "test-wrapper", version: "1" },
  model: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "not measured" },
  attempts: null,
  repairs: null,
  events: [],
  limitations: ["Local test only"],
};
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "arena-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const starterDir = join(root, "starter");
  const solutionDir = join(root, "solution");
  mkdirSync(starterDir);
  mkdirSync(solutionDir);
  writeFileSync(join(starterDir, "index.mjs"), "export const answer = 0;\n");
  writeFileSync(join(solutionDir, "index.mjs"), "export const answer = 42;\n");
  const oracleFile = join(root, "oracle.mjs");
  writeFileSync(
    oracleFile,
    `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const ok=readFileSync(join(process.argv[2],'index.mjs'),'utf8')==='export const answer = 42;\\n';
const error='answer must equal 42';
writeFileSync(Number(process.env.ARENA_SCORE_FD),JSON.stringify({schemaVersion:1,passed:ok?1:0,total:1,failed:ok?[]:[error],cases:[ok?{id:0,passed:true}:{id:0,passed:false,error}]}));process.exitCode=ok?0:1;`,
  );
  const task: ArenaTask = {
    id: "fixture",
    version: 1,
    title: "Fixture",
    prompt: "Export answer 42 from index.mjs",
    starterDir,
    solutionDir,
    oracleFile,
    oracleCaseCount: 1,
    units: [{ id: "answer", files: ["index.mjs"], prompt: "Implement answer" }],
  };
  const options: ArenaOptions = {
    out: join(root, "results"),
    tasks: [task],
    workflows: ["sequential"],
    timeoutMs: 5000,
  };
  function external(
    body = `writeFileSync(join(request.cwd,'index.mjs'),'export const answer = 42;\\n');`,
    response: unknown = goodResponse,
  ): AdapterConfig {
    const script = join(root, `adapter-${readdirSync(root).length}.mjs`);
    writeFileSync(
      script,
      `import {readFileSync,writeFileSync,readdirSync,symlinkSync} from 'node:fs';import {join,dirname} from 'node:path';
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));${body}\nconsole.log(JSON.stringify(${JSON.stringify(response)}));`,
    );
    return { name: "local-test", command: process.execPath, args: [script], model: null };
  }
  return { root, task, options, external };
}
function evidence(directory: string, runId: string) {
  return join(directory, "runs", runId, "evidence");
}

test("offline workflows repeat identical starters and retain public-only candidates and stage evidence", async (t) => {
  const { options } = fixture(t);
  const batch = await runArena({
    ...options,
    workflows: ["sequential", "parallel", "sequential-review", "parallel-review"],
    trials: 2,
  });
  assert.equal(batch.results.length, 8);
  assert.ok(
    batch.results.every((result) => result.status === "completed" && result.oracle?.passed === 1),
  );
  assert.equal(new Set(batch.results.map((result) => result.provenance.startingRevision)).size, 1);
  for (const result of batch.results) {
    const runDir = join(batch.directory, "runs", result.runId);
    assert.deepEqual(readdirSync(join(runDir, "candidate")).sort(), [".git", "index.mjs"]);
    const request = JSON.parse(readFileSync(join(runDir, "request.json"), "utf8"));
    assert.equal(request.task.oracleFile, undefined);
    assert.equal(request.task.solutionDir, undefined);
    assert.ok(existsSync(join(runDir, "evidence", "offline", "events.json")));
    assert.equal(result.response?.usage.costUsd, 0);
    assert.ok(result.provenance.corpusSha256 && result.provenance.arenaSourceSha256);
  }
  assert.match(
    readFileSync(join(batch.directory, "report.md"), "utf8"),
    /not evidence about live coding models/,
  );
});

test("broken controls retain failing candidates, raw oracle output and full trial denominator", async (t) => {
  const { options } = fixture(t);
  const {
    directory,
    results: [result],
  } = await runArena({ ...options, offlineMode: "broken" });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.oracle, {
    schemaVersion: 1,
    passed: 0,
    total: 1,
    failed: ["answer must equal 42"],
    cases: [{ id: 0, passed: false, error: "answer must equal 42" }],
  });
  const dir = evidence(directory, result.runId);
  assert.match(readFileSync(join(dir, "oracle.score.json"), "utf8"), /answer must equal 42/);
  assert.ok(existsSync(join(dir, "adapter-response.json")));
  assert.ok(existsSync(join(dir, "final.diff")));
  assert.match(readFileSync(join(directory, "report.md"), "utf8"), /0\/1/);
});

test("external execution requires explicit opt-in before creating artifacts", async (t) => {
  const { options, external } = fixture(t);
  await assert.rejects(runArena({ ...options, adapter: external() }), /allow-external/);
  assert.equal(existsSync(options.out), false);
});

test("external protocol accepts unknown measurements and preserves them as unknown", async (t) => {
  const { options, external } = fixture(t);
  const {
    directory,
    results: [result],
  } = await runArena({ ...options, adapter: external(), allowExternal: true });
  assert.equal(result.status, "completed");
  assert.equal(result.response?.attempts, null);
  const report = readFileSync(join(directory, "report.md"), "utf8");
  assert.match(report, /unknown \| unknown \| unknown \| unknown \| unknown/);
  assert.match(report, /model identities or versions are unknown/);
});

test("malformed or missing adapter fields fail without discarding oracle evidence", async (t) => {
  const { options, external } = fixture(t);
  const invalid = { ...goodResponse, attempts: undefined };
  const {
    directory,
    results: [result],
  } = await runArena({ ...options, adapter: external(undefined, invalid), allowExternal: true });
  assert.equal(result.status, "failed");
  assert.equal(result.response, null);
  assert.equal(result.oracle?.passed, 1);
  assert.ok(result.errors.some((error) => /Invalid adapter response/.test(error)));
  assert.match(
    readFileSync(join(evidence(directory, result.runId), "adapter.stdout.log"), "utf8"),
    /test-wrapper/,
  );
});

test("adapter timeout keeps partial edits, stage evidence, and an evaluated failure", async (t) => {
  const { options, external } = fixture(t);
  const adapter = external(
    `writeFileSync(join(request.cwd,'partial.txt'),'partial');writeFileSync(join(request.evidenceDir,'started.txt'),'started');setInterval(()=>{},1000);`,
  );
  const {
    directory,
    results: [result],
  } = await runArena({ ...options, adapter, allowExternal: true, timeoutMs: 200 });
  assert.equal(result.status, "failed");
  assert.equal(result.adapterProcess?.timedOut, true);
  assert.equal(result.oracle?.passed, 0);
  assert.ok(result.finalFiles?.some((file) => file.path === "partial.txt"));
  assert.equal(
    readFileSync(join(evidence(directory, result.runId), "started.txt"), "utf8"),
    "started",
  );
});

test("noisy output is capped and truncated JSON is never treated as a valid response", async (t) => {
  const { options, external } = fixture(t);
  const {
    directory,
    results: [result],
  } = await runArena({
    ...options,
    adapter: external("process.stdout.write('x'.repeat(10000));"),
    allowExternal: true,
    maxLogBytes: 128,
  });
  assert.equal(result.adapterProcess?.stdoutTruncated, true);
  assert.equal(result.response, null);
  assert.equal(statSync(join(evidence(directory, result.runId), "adapter.stdout.log")).size, 128);
});

test("oracle timeout is unknown correctness, never an empty passing score", async (t) => {
  const { options, task } = fixture(t);
  writeFileSync(task.oracleFile, "console.error('oracle started');setInterval(()=>{},1000);");
  const {
    directory,
    results: [result],
  } = await runArena({ ...options, oracleTimeoutMs: 150 });
  assert.equal(result.oracle, null);
  assert.equal(result.oracleProcess?.timedOut, true);
  assert.equal(result.status, "failed");
  assert.match(
    readFileSync(join(evidence(directory, result.runId), "oracle.stderr.log"), "utf8"),
    /oracle started/,
  );
});

test("batch reservation never overwrites existing evidence and unsafe paths are rejected", async (t) => {
  const { options, task } = fixture(t);
  const first = await runArena({ ...options, batchId: "fixed" });
  const before = readFileSync(join(first.directory, "report.md"), "utf8");
  await assert.rejects(runArena({ ...options, batchId: "fixed" }), /EEXIST/);
  assert.equal(readFileSync(join(first.directory, "report.md"), "utf8"), before);
  await assert.rejects(runArena({ ...options, batchId: "../escape" }), /Unsafe batch/);
  await assert.rejects(
    runArena({ ...options, tasks: [{ ...task, id: "../escape" }] }),
    /Unsafe task/,
  );
  await assert.rejects(
    runArena({
      ...options,
      tasks: [{ ...task, units: [{ id: "x", prompt: "x", files: ["../escape"] }] }],
    }),
    /Unsafe task file/,
  );
});

test(
  "candidate symlinks skip evaluation and source symlink output is rejected",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, options, task, external } = fixture(t);
    const {
      results: [result],
    } = await runArena({
      ...options,
      adapter: external(
        `symlinkSync(${JSON.stringify(task.oracleFile)},join(request.cwd,'leak.mjs'));`,
      ),
      allowExternal: true,
    });
    assert.equal(result.oracle, null);
    assert.ok(result.errors.some((error) => /symlink prohibited/.test(error)));
    assert.ok(result.finalFiles?.some((file) => file.kind === "symlink"));
    const alias = join(root, "alias");
    symlinkSync(task.starterDir, alias);
    await assert.rejects(
      runArena({ ...options, out: join(alias, "output") }),
      /outside arena source and task inputs/,
    );
    assert.equal(existsSync(join(task.starterDir, "output")), false);
  },
);

test("all planned result artifacts exist before execution and abrupt interruption retains their denominator", async (t) => {
  const { root, options, external } = fixture(t);
  const adapter = external(
    `const runs=dirname(dirname(request.cwd));const dirs=readdirSync(runs);if(dirs.length!==4)throw new Error('missing planned cells');for(const dir of dirs)JSON.parse(readFileSync(join(runs,dir,'result.json'),'utf8'));process.kill(process.ppid,'SIGKILL');process.exit(0);`,
  );
  const entry = join(root, "interrupt.mjs");
  writeFileSync(
    entry,
    `import {runArena} from ${JSON.stringify(pathToFileURL(resolve("arena/runner.ts")).href)};await runArena(${JSON.stringify({ ...options, adapter, allowExternal: true, trials: 2, workflows: ["sequential", "parallel"], batchId: "interrupted" })});`,
  );
  const processResult = await runProcess({
    command: process.execPath,
    args: [entry],
    cwd: root,
    timeoutMs: 5000,
    maxLogBytes: 4096,
    stdoutFile: join(root, "outer.stdout"),
    stderrFile: join(root, "outer.stderr"),
  });
  assert.notEqual(processResult.code, 0);
  const loaded = loadResults([join(options.out, "interrupted")]);
  assert.equal(loaded.length, 4);
  assert.equal(loaded.filter((result) => result.status === "pending").length, 3);
  assert.match(renderReport(loaded), /4 requested trial cells recorded/);
});

test("oracle-induced file mutations invalidate otherwise passing evaluation", async (t) => {
  const { options, task } = fixture(t);
  writeFileSync(
    task.oracleFile,
    `import {writeFileSync} from 'node:fs';import {join} from 'node:path';writeFileSync(join(process.argv[2],'index.mjs'),'export const answer=0;');writeFileSync(Number(process.env.ARENA_SCORE_FD),JSON.stringify({schemaVersion:1,passed:1,total:1,failed:[],cases:[{id:0,passed:true}]}));`,
  );
  const {
    directory,
    results: [result],
  } = await runArena(options);
  assert.equal(result.status, "failed");
  assert.equal(result.oracle?.passed, 1);
  assert.ok(result.errors.some((error) => /changed during oracle/.test(error)));
  assert.notEqual(
    readFileSync(join(evidence(directory, result.runId), "evaluated-snapshot.json"), "utf8"),
    readFileSync(join(evidence(directory, result.runId), "final-snapshot.json"), "utf8"),
  );
});

test("semantic model equality accepts reordered keys and rejects changed settings", async (t) => {
  const { options, external } = fixture(t);
  const model = {
    provider: "local",
    id: "fixture",
    version: "1",
    settings: { temperature: 0, seed: 1 },
  };
  const equivalent = {
    settings: { seed: 1, temperature: 0 },
    version: "1",
    id: "fixture",
    provider: "local",
  };
  const ok = await runArena({
    ...options,
    adapter: { ...external(undefined, { ...goodResponse, model: equivalent }), model },
    allowExternal: true,
  });
  assert.equal(ok.results[0].status, "completed");
  const bad = await runArena({
    ...options,
    adapter: {
      ...external(undefined, {
        ...goodResponse,
        model: { ...model, settings: { temperature: 1 } },
      }),
      model,
    },
    allowExternal: true,
  });
  assert.ok(bad.results[0].errors.some((error) => /Reported model differs/.test(error)));
});

test("comparison reports flag mismatches and never pool incompatible contexts", async (t) => {
  const { options } = fixture(t);
  const {
    results: [original],
  } = await runArena(options);
  const changed = structuredClone(original);
  changed.batchId = "other-batch";
  changed.provenance.runtime.arch = "different";
  changed.provenance.corpusSha256 = "different";
  changed.provenance.configSha256 = "different";
  const warnings = comparisonWarnings([original, changed]).join("\n");
  assert.match(warnings, /configuration/);
  assert.match(warnings, /wall times are not directly comparable/);
  assert.match(warnings, /mismatched corpus/);
  const report = renderReport([original, changed]);
  assert.match(report, /other-batch/);
  assert.equal((report.match(/\| 1\/1 \| 1\/1 \| 1\/1 \|/g) ?? []).length, 2);
});

test("missing telemetry and setup failures remain in the planned treatment denominator", async (t) => {
  const { options } = fixture(t);
  const {
    results: [original],
  } = await runArena(options);
  const failed = structuredClone(original);
  failed.trial = 2;
  failed.order = 2;
  failed.runId = "fixture-sequential-trial-2";
  failed.status = "failed";
  failed.response = null;
  failed.oracle = null;
  failed.candidateCorrect = null;
  failed.provenance.startingRevision = null;
  failed.errors.push("setup failed");
  const report = renderReport([original, failed]);
  assert.match(report, /\| 1\/2 \| 1\/2 \| 1\/2 \|/);
  assert.doesNotMatch(report, /\| 1\/1 \| 1\/1 \| 1\/1 \|/);
});

test("process failures and preexisting log files return errors without clobbering", async (t) => {
  const { root } = fixture(t);
  const options = {
    command: "missing-arena-command-12345",
    args: [],
    cwd: root,
    timeoutMs: 100,
    maxLogBytes: 100,
    stdoutFile: join(root, "process.stdout"),
    stderrFile: join(root, "process.stderr"),
  };
  const missing = await runProcess(options);
  assert.match(missing.error ?? "", /ENOENT/);
  writeFileSync(options.stdoutFile, "preserved");
  const collision = await runProcess(options);
  assert.match(collision.error ?? "", /EEXIST/);
  assert.equal(readFileSync(options.stdoutFile, "utf8"), "preserved");
});

test(
  "POSIX timeout kills a TERM-ignoring descendant after the leader exits",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root } = fixture(t);
    const pidFile = join(root, "descendant.pid");
    const descendant = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000);`,
      ],
      cwd: root,
      timeoutMs: 300,
      maxLogBytes: 4096,
      stdoutFile: join(root, "group.stdout"),
      stderrFile: join(root, "group.stderr"),
    });
    assert.equal(result.timedOut, true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    t.after(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* Reaped. */
    }
    if (alive && process.platform === "linux")
      alive = !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    assert.equal(alive, false);
  },
);

test("validators reject invalid usage, unsafe options and oversized snapshots", (t) => {
  const { task } = fixture(t);
  assert.throws(
    () =>
      parseAdapterResponse(
        JSON.stringify({ ...goodResponse, usage: { ...goodResponse.usage, costUsd: -1 } }),
      ),
    /Invalid adapter response/,
  );
  assert.throws(
    () => parseAdapterConfig({ name: "x", command: "x", args: [1] }),
    /Invalid adapter config/,
  );
  assert.throws(
    () =>
      parseAdapterResponse(
        JSON.stringify({ ...goodResponse, attempts: Number.MAX_SAFE_INTEGER + 1 }),
      ),
    /Invalid adapter response/,
  );
  assert.throws(
    () => parseAdapterResponse(JSON.stringify({ ...goodResponse, status: ["completed"] })),
    /Invalid adapter response/,
  );
  assert.throws(
    () => parseAdapterConfig({ name: "x", command: "x", timeoutMs: 2_147_483_648 }),
    /Invalid adapter config/,
  );
  assert.throws(() => parseArgs(["--task", "missing"]), /Unknown or repeated task/);
  assert.throws(() => parseArgs(["--trials", "1.5"]), /integer/);
  assert.throws(() => parseArgs(["--out", "--offline"]), /Missing value/);
  writeFileSync(join(task.starterDir, "large"), Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(() => treeManifest(task.starterDir), /snapshot limit/);
});
