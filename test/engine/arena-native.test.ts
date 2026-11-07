import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeInvocation, executeNative, pinataIntegrated } from "../../arena/adapters/native.ts";
import { tasks } from "../../arena/corpus/index.ts";
import { runArena } from "../../arena/runner.ts";
import { readAdapterRequest } from "../../arena/adapters/protocol.ts";
import type { AdapterRequest } from "../../arena/types.ts";

function request(root: string): AdapterRequest {
  const task = tasks[0]!;
  return {
    schemaVersion: 1,
    runId: "native-test",
    task: { id: task.id, version: task.version, prompt: task.prompt, units: task.units },
    workflow: "native",
    cwd: root,
    evidenceDir: join(root, "evidence"),
    startingRevision: "fixture",
    model: {
      provider: "openai",
      id: "gpt-6-luna",
      version: null,
      settings: { thinking: "max", concurrency: 2 },
    },
    limits: { timeoutMs: 10000, maxRepairs: 1 },
  };
}

test("native invocation sends the whole task and enables Codex subagents with matched defaults", () => {
  const req = request("/tmp/candidate");
  assert.equal(
    nativeInvocation("codex", req, "/tmp/installed-codex").command,
    "/tmp/installed-codex",
  );
  assert.throws(() => nativeInvocation("codex", req, "relative-codex"), /absolute path/);
  const codex = nativeInvocation("codex", req);
  assert.equal(codex.command, "codex");
  assert.ok(!codex.args.includes("--ephemeral"), "Native subagents need persisted thread context");
  assert.ok(codex.args.includes("agents.enabled=true"));
  assert.ok(codex.args.includes('agents.default_subagent_model="gpt-6-luna"'));
  assert.ok(codex.args.includes("agents.max_concurrent_threads_per_session=2"));
  for (const unit of req.task.units) assert.ok(codex.args.at(-1)!.includes(unit.prompt));
  assert.ok(!codex.args.at(-1)!.includes("Do not delegate"));
  const pi = nativeInvocation("pi", req);
  assert.ok(pi.args.includes("--no-extensions"));
  assert.ok(!pi.args.includes("-e"));
  const pinata = nativeInvocation("pinata", req);
  assert.ok(pinata.args.some((arg) => arg.endsWith("arena/adapters/coordinator.ts")));
  assert.ok(pinata.prompt!.includes("pinata_integrate"));
  assert.ok(pinata.prompt!.includes("finish your current response promptly"));
  assert.ok(pinata.prompt!.includes("corrected run with the remaining time"));
  const input = JSON.parse(pinata.input!);
  assert.equal(input.type, "prompt");
  assert.equal(
    JSON.parse(input.message.slice("/pinata-arena-execute ".length)),
    pinata.prompt,
    "RPC receives the same operational guidance retained in the prompt",
  );
  assert.ok(
    pinata.prompt!.includes('"reviewer":{"provider":"openai","id":"gpt-6-luna","thinking":"max"}'),
  );
  assert.throws(() => nativeInvocation("codex", { ...req, workflow: "sequential" }), /native/);
  assert.throws(
    () =>
      nativeInvocation("codex", { ...req, model: { ...req.model!, settings: { concurrency: 0 } } }),
    /concurrency/,
  );
});

test("Piñata completion requires observed successful run then verified integration", () => {
  const event = (toolName: string, status: string, isError = false) =>
    JSON.stringify({
      type: "tool_execution_end",
      toolName,
      isError,
      result: { details: { result: { status } } },
    });
  const run = event("pinata_run", "succeeded");
  const integrate = event("pinata_integrate", "verified");
  assert.equal(pinataIntegrated(run), false);
  assert.equal(pinataIntegrated(integrate + "\n" + run), false);
  assert.equal(pinataIntegrated(run + "\n" + event("pinata_integrate", "verified", true)), false);
  assert.equal(pinataIntegrated(run + "\n" + integrate), true);
});

test("native external run retains failures, scores mock implementation and round-trips reports without model calls", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arena-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const mock = join(root, "codex");
  await writeFile(
    mock,
    `#!${process.execPath}\nimport {copyFileSync,readdirSync} from 'node:fs';import{join}from'node:path';if(process.argv.includes('--version'))console.log('mock-codex');else{for(const file of readdirSync(${JSON.stringify(tasks[0]!.solutionDir)}))copyFileSync(join(${JSON.stringify(tasks[0]!.solutionDir)},file),join(process.cwd(),file));console.log(JSON.stringify({type:'mock-completed'}));}\n`,
  );
  await chmod(mock, 0o755);
  const adapter = {
    name: "mock-native",
    command: process.execPath,
    args: [resolve("arena/adapters/native.ts"), "codex"],
    model: request(root).model,
    timeoutMs: 10000,
  };
  const batch = await runArena({
    out: join(root, "results"),
    tasks: [tasks[0]!],
    workflows: ["native"],
    adapter,
    allowExternal: true,
  });
  assert.equal(
    batch.results[0]!.status,
    "completed",
    batch.results[0]!.errors.join("\n") +
      " STDERR: " +
      (await readFile(
        join(batch.directory, "runs", batch.results[0]!.runId, "evidence/adapter.stderr.log"),
        "utf8",
      )) +
      " STDOUT: " +
      (await readFile(
        join(batch.directory, "runs", batch.results[0]!.runId, "evidence/adapter.stdout.log"),
        "utf8",
      )),
  );
  assert.equal(batch.results[0]!.candidateCorrect, true);
  assert.equal(batch.results[0]!.comparisonEligible, false);
  assert.equal(batch.results[0]!.treatment.status, "unverified");
  assert.equal(batch.results[0]!.response!.usage.inputTokens, null);
  const reqFile = join(batch.directory, "runs", batch.results[0]!.runId, "request.json");
  assert.equal((await readAdapterRequest(reqFile)).workflow, "native");
  const { spawnSync } = await import("node:child_process");
  const report = spawnSync(process.execPath, ["arena/report.ts", batch.directory], {
    encoding: "utf8",
  });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /native/);
  await writeFile(
    mock,
    `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('mock-codex');else{console.error('test failure');process.exitCode=7;}\n`,
  );
  const failed = await executeNative("codex", {
    ...request(root),
    evidenceDir: join(root, "failed"),
  });
  assert.equal(failed.status, "failed");
  assert.match(await readFile(join(root, "failed/native.stderr.log"), "utf8"), /test failure/);
  await assert.rejects(
    runArena({ out: join(root, "offline"), tasks: [tasks[0]!], workflows: ["native"] }),
    /external adapter/,
  );
});

test(
  "native timeout keeps agent descendants in the arena supervisor cleanup group",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "arena-native-timeout-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const mock = join(root, "mock-codex"),
      pidFile = join(root, "child.pid");
    await writeFile(
      mock,
      `#!${process.execPath}\nimport{spawn}from'node:child_process';import{writeFileSync}from'node:fs';if(process.argv.includes('--version'))console.log('mock');else{const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);}\n`,
    );
    await chmod(mock, 0o755);
    const batch = await runArena({
      out: join(root, "results"),
      tasks: [tasks[0]!],
      workflows: ["native"],
      allowExternal: true,
      adapter: {
        name: "mock-timeout",
        command: process.execPath,
        args: [resolve("arena/adapters/native.ts"), "codex", "--executable", mock],
        model: request(root).model,
        timeoutMs: 4000,
      },
    });
    assert.equal(batch.results[0]!.status, "failed");
    const pid = Number(await readFile(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const state = await readFile(`/proc/${pid}/stat`, "utf8");
        alive = !/\) Z /.test(state);
      } catch {
        alive = false;
      }
      if (!alive) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (alive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Best effort test cleanup. */
      }
    }
    assert.equal(alive, false, "Supervisor must reap the nested agent's TERM-ignoring descendant");
  },
);

test("native Codex spawn errors cannot silently count as successful solo runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arena-spawn-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = join(root, "mock-codex");
  await writeFile(
    mock,
    `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('mock');else{console.error('collab spawn failed: no rollout found for thread id test');console.log(JSON.stringify({type:'turn.completed'}));}\n`,
  );
  await chmod(mock, 0o755);
  const result = await executeNative("codex", request(root), mock);
  assert.equal(result.status, "failed");
  assert.match(result.events[0]!.detail!, /delegationFailed=true/);
});

test("canceling native run stops its process and leaves queued trials unstarted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arena-native-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = join(root, "mock-codex"),
    marker = join(root, "started");
  await writeFile(
    mock,
    `#!${process.execPath}\nimport{writeFileSync}from'node:fs';if(process.argv.includes('--version'))console.log('mock');else{writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);}\n`,
  );
  await chmod(mock, 0o755);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  t.after(() => clearTimeout(timer));
  const batch = await runArena({
    out: join(root, "results"),
    tasks: [tasks[0]!],
    workflows: ["native"],
    trials: 2,
    signal: controller.signal,
    allowExternal: true,
    adapter: {
      name: "mock-cancel",
      command: process.execPath,
      args: [resolve("arena/adapters/native.ts"), "codex", "--executable", mock],
      model: request(root).model,
      timeoutMs: 10000,
    },
  });
  assert.equal(await readFile(marker, "utf8"), "started");
  assert.equal(batch.results[0]!.status, "failed");
  assert.ok(batch.results[0]!.errors.some((error) => /cancel/i.test(error)));
  assert.equal(batch.results[1]!.status, "pending");
  assert.equal(batch.results[1]!.startedAt, null);
});
