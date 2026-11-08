import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startLoopback, type LoopbackReply } from "../../bench/providers/loopback.ts";
import { executeNative, nativeInvocation, pinataDelegated } from "../../arena/adapters/native.ts";
import { runProcess } from "../../arena/process.ts";
import type { AdapterRequest } from "../../arena/types.ts";
import { gitRepo } from "./faux.ts";
import { tempDir } from "./helpers.ts";
import { processStart } from "../../engine/backends/supervise.ts";
import { killTree } from "../../engine/verify/checks.ts";

const cli = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "cli.js",
);
const publicAssignment = "Titles contain 1–100 characters. Default status: open.";
const model = { provider: "pinata-loopback", id: "loopback", thinking: "off" };
const call = (name: string, args: unknown): LoopbackReply => ({
  toolCalls: [{ name, arguments: args }],
});
const submit = (extra: Record<string, unknown> = {}): LoopbackReply =>
  call("submit_result", {
    status: "succeeded",
    summary: "done",
    brief: "fixture evidence",
    changedFiles: [],

    findings: [],
    blockers: [],
    ...extra,
  });
const contents = (body: { messages?: Array<{ content?: unknown }> }) =>
  (body.messages ?? [])
    .map(({ content }) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => part.text ?? "").join("\n")
          : "",
    )
    .join("\n");

function request(repo: string, evidenceDir: string): AdapterRequest {
  return {
    schemaVersion: 1,
    runId: "coordinator-test",
    workflow: "native",
    cwd: repo,
    evidenceDir,
    startingRevision: "fixture",
    task: {
      id: "public-fixture",
      version: 1,
      prompt: publicAssignment,
      units: [{ id: "content", files: ["README.md"], prompt: "Implement the public contract." }],
    },
    model: {
      provider: model.provider,
      id: model.id,
      version: null,
      settings: { thinking: "off", concurrency: 3 },
    },
    limits: { timeoutMs: 30_000, maxRepairs: 2 },
    deadlineAt: Date.now() + 30_000,
  };
}

test("installed RPC coordinator receives assignment completions and continues a worker while another runs", async (t) => {
  const dir = await tempDir(t, "pinata-coordinator-");
  const repo = join(dir, "repo");
  await gitRepo(repo).init();
  const agentDir = join(dir, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  t.after(releaseSlow);
  let started = false;
  let continued = false;
  let addedReviewer = false;
  let slowFinished = false;
  let buildCalls = 0;
  const loopback = await startLoopback({
    tokenDelayMs: 0,
    responder: async ({ body }) => {
      const text = contents(body);
      const task = /# Task ([a-z-]+) \(/.exec(text)?.[1];
      if (task) {
        assert(text.includes(publicAssignment));
        if (task === "audit") return { text: "Reviewed README.md; no findings." };
        if (task === "slow") {
          await slow;
          slowFinished = true;
          return submit();
        }
        const callNumber = buildCalls++;
        if (callNumber === 0 || callNumber === 2)
          return call("write", {
            path: "README.md",
            content: callNumber === 0 ? "first" : "fixed",
          });
        if (callNumber === 3) releaseSlow();
        return submit();
      }
      if (!started) {
        started = true;
        return call("pinata_run", {
          background: true,
          config: { models: { default: model }, setup: false, codemode: false },
          tasks: [
            { id: "build", agent: "builder", task: "Implement the title contract in README.md" },
            { id: "slow", agent: "scout", task: "Independent inspection" },
          ],
        });
      }
      if (text.includes("assignment completed: build/1") && !continued) {
        assert.equal(slowFinished, false);
        continued = true;
        const run = /"run"\s*:\s*"([a-f0-9-]{36})"/.exec(text)?.[1];
        assert(run);
        return call("pinata_steer", {
          run,
          task: "build",
          message: "Fix title",
          as: "followUp",
          messageId: "second-assignment",
        });
      }
      if (text.includes("assignment completed: build/2") && !addedReviewer) {
        addedReviewer = true;
        const run = /"run"\s*:\s*"([a-f0-9-]{36})"/.exec(text)?.[1];
        assert(run);
        return call("pinata_run", {
          run,
          background: true,
          config: { models: { default: model }, setup: false, codemode: false },
          tasks: [
            {
              id: "audit",
              agent: "reviewer",
              task: "Review README.md",
              after: ["build", "slow"],
              reviewBase: "HEAD",
            },
          ],
        });
      }
      return { text: "Waiting for assignment completions." };
    },
  });
  t.after(() => loopback.close());
  await loopback.writeModels(agentDir);
  const req = request(repo, join(dir, "evidence"));
  const result = await executeNative("pinata", req, process.env.PINATA_TEST_NATIVE_PI ?? cli);
  const stdout = await readFile(join(req.evidenceDir, "native.stdout.jsonl"), "utf8");
  assert.equal(result.status, "completed", JSON.stringify(result.events) + stdout.slice(-8000));
  assert(continued);
  assert(addedReviewer);
  assert(!stdout.includes("unknown dependency"));
  assert.equal(buildCalls, 4);
  assert(pinataDelegated(stdout));
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "fixed");
  const notifications = stdout
    .split("\n")
    .filter(
      (line) =>
        line.includes('"type":"message_end"') && line.includes('"customType":"pinata-assignment"'),
    )
    .map((line) => JSON.parse(line).message.details.notificationId);
  assert.equal(new Set(notifications).size, 4);
});

test("installed Pi print mode exits before delayed background completion", async (t) => {
  const dir = await tempDir(t, "pinata-print-lifecycle-");
  const repo = join(dir, "repo");
  await gitRepo(repo).init();
  const agentDir = join(dir, "agent");
  let parentTurns = 0;
  const loopback = await startLoopback({
    tokenDelayMs: 0,
    responder: async ({ body }) => {
      if (/# Task slow \(/.test(contents(body))) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return submit();
      }
      if (parentTurns++ === 0)
        return call("pinata_run", {
          background: true,
          survive: false,
          config: { models: { default: model }, codemode: false },
          tasks: [{ id: "slow", role: "scout", task: "Delayed result" }],
        });
      return { text: "Waiting." };
    },
  });
  t.after(() => loopback.close());
  await loopback.writeModels(agentDir);
  const evidence = join(dir, "evidence");
  await mkdir(evidence);
  const invocation = nativeInvocation("pinata", request(repo, evidence), cli);
  const args = invocation.args.filter(
    (arg, index, all) =>
      arg !== "--pinata-arena-request" && all[index - 1] !== "--pinata-arena-request",
  );
  args[args.indexOf("rpc")] = "json";
  args[args.findIndex((arg) => arg.endsWith("arena/adapters/coordinator.ts"))] =
    resolve("engine/pi/extension.ts");
  const result = await runProcess({
    command: process.execPath,
    args: [cli, ...args, "--print", "--", "Start the delayed background run."],
    cwd: repo,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    timeoutMs: 15000,
    maxLogBytes: 1024 * 1024,
    stdoutFile: join(evidence, "stdout"),
    stderrFile: join(evidence, "stderr"),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(parentTurns, 2);
  assert(
    !result.stdout.includes('"customType":"pinata-assignment"'),
    "no future follow-up turn survives print completion",
  );
});

for (const { backend, survive } of [
  { backend: "in-process", survive: false },
  { backend: "process", survive: false },
  { backend: "process", survive: true },
] as const) {
  test(`arena timeout stops the coordinator and its ${backend} worker's running shell (survive:${survive})`, async (t) => {
    const dir = await tempDir(t, "pinata-arena-timeout-");
    const repo = join(dir, "repo");
    const worktrees = join(dir, "worktrees");
    await gitRepo(repo).init();
    const agentDir = join(dir, "agent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    });
    let started = false;
    const loopback = await startLoopback({
      tokenDelayMs: 0,
      responder: ({ body }) => {
        if (/# Task build \(/.test(contents(body))) {
          const script =
            "require('fs').writeFileSync('worker.pid',String(process.pid));setInterval(()=>{},1000)";
          return call("bash", {
            command: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} -e ${JSON.stringify(script)}`,
          });
        }
        if (started) return { text: "Waiting for the worker." };
        started = true;
        return call("pinata_run", {
          background: true,
          survive,
          approval: "Fixture worker and shell authorized",
          config: {
            models: { default: model },
            backend,
            setup: false,
            codemode: false,
            worktreeRoot: worktrees,
            // Deliberately longer than the arena: outer cleanup must enforce the trial limit.
          },
          tasks: [
            {
              id: "build",
              role: "builder",
              task: "Run the fixture shell",
            },
          ],
        });
      },
    });
    t.after(() => loopback.close());
    await loopback.writeModels(agentDir);
    const req = request(repo, join(dir, "evidence"));
    req.limits.timeoutMs = 10_000;
    req.deadlineAt = Date.now() + req.limits.timeoutMs;
    const result = await executeNative("pinata", req, cli);
    assert.equal(result.status, "failed");
    assert.match(JSON.stringify(result.events), /timedOut=true/);
    const pid = Number(await readFile(join(repo, "worker.pid"), "utf8"));
    t.after(() => killTree(pid));
    assert.equal(await processStart(pid), null, "the shell process did not escape the trial");
    // Windows taskkill forcibly stops the process tree; it cannot flush a final event.
    if (process.platform === "win32") return;
    const runs = join(repo, ".git", "pinata");
    const logs = (await readdir(runs, { recursive: true })).filter(
      (file) => file.endsWith("events.jsonl") && !file.includes("agents"),
    );
    assert.equal(logs.length, 1);
    const events = (await readFile(join(runs, logs[0]), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).t, "run_settled", "cooperative shutdown flushed the run evidence");
    assert.equal(events.at(-1).status, "cancelled");
  });
}
