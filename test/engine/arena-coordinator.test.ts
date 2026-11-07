import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startLoopback, type LoopbackReply } from "../../bench/providers/loopback.ts";
import { executeNative, nativeInvocation, pinataIntegrated } from "../../arena/adapters/native.ts";
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
    checks: [],
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

test("installed Pi RPC coordinator receives two early notices, repairs without blocking, then integrates before exit", async (t) => {
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
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  t.after(releaseSlow);
  let slowFinished = false;
  let started = false;
  let repairs = 0;
  let reviews = 0;
  let integrated = false;
  const briefs: Array<{ task: string; text: string }> = [];
  const loopback = await startLoopback({
    tokenDelayMs: 0,
    responder: async ({ body }) => {
      const text = contents(body);
      const task = /# Task ([a-z-]+) \(/.exec(text)?.[1];
      if (task) {
        assert(text.includes(publicAssignment), `${task} receives exact assignment`);
        const round = body.messages.filter(
          (message: { role: string }) => message.role === "assistant",
        ).length;
        if (round === 0) briefs.push({ task, text });
        if (task === "slow") {
          await slowGate;
          slowFinished = true;
          return submit();
        }
        if (task === "build") {
          assert(text.includes("Ownership (repository-relative): README.md"));
          if (round === 0)
            return call("write", {
              path: "README.md",
              content: text.includes("Repair feedback") ? "fixed" : "broken",
            });
          return submit({ changedFiles: ["README.md"] });
        }
        reviews++;
        const approve = reviews >= 3;
        if (approve) releaseSlow();
        return submit({
          review: { verdict: approve ? "approve" : "changes_requested" },
          findings: approve
            ? []
            : [{ severity: "high", message: "Fix the title contract", evidence: "README.md:1" }],
        });
      }
      if (!started) {
        started = true;
        return call("pinata_run", {
          background: true,
          survive: false,
          approval: "Fixture local edits and integration authorized",
          instructions: [],
          config: {
            models: { default: model },
            setup: false,
            codemode: false,
            worktreeRoot: join(dir, "worktrees"),
            limits: { concurrency: 3, repairs: 2 },
          },
          tasks: [
            {
              id: "build",
              role: "builder",
              task: "enforce lengths",
              ownership: ["README.md"],
              checks: [
                {
                  id: "content",
                  argv: [
                    process.execPath,
                    "-e",
                    "require('assert/strict').ok(require('fs').readFileSync('README.md','utf8'))",
                  ],
                },
              ],
            },
            {
              id: "review",
              role: "reviewer",
              task: "Check the contract",
              after: ["build"],
              reviewOf: "build",
            },
            { id: "slow", role: "scout", task: "Independent branch" },
          ],
          integratedChecks: [
            {
              id: "final",
              argv: [
                process.execPath,
                "-e",
                "require('assert/strict').equal(require('fs').readFileSync('README.md','utf8'),'fixed')",
              ],
            },
          ],
        });
      }
      const run = /"run"\s*:\s*"([a-f0-9-]{36})"/.exec(text)?.[1];
      const notices = new Set(
        [...text.matchAll(/"noticeId"\s*:\s*"([^"]+)"/g)].map((match) => match[1]),
      );
      if (notices.size > repairs && repairs < 2) {
        assert.equal(slowFinished, false, "intervention precedes unrelated branch completion");
        repairs++;
        assert(run);
        return call("pinata_repair", {
          run,
          task: "build",
          feedback: "Fix the exact title limit",
          background: true,
        });
      }
      if (text.includes("settled: succeeded") && !integrated) {
        integrated = true;
        assert(run);
        return call("pinata_integrate", { run });
      }
      return { text: integrated ? "Complete." : "Waiting for the background result." };
    },
  });
  t.after(() => loopback.close());
  await loopback.writeModels(agentDir);
  const req = request(repo, join(dir, "evidence"));
  const result = await executeNative("pinata", req, cli);
  const stdout = await readFile(join(req.evidenceDir, "native.stdout.jsonl"), "utf8");
  const stderr = await readFile(join(req.evidenceDir, "native.stderr.log"), "utf8");
  assert.equal(
    result.status,
    "completed",
    JSON.stringify(result.events) + "\n" + stdout.slice(-16000) + "\n" + stderr,
  );
  assert.equal(repairs, 2);
  assert.equal(reviews, 3);
  assert.equal(pinataIntegrated(stdout), true);
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "fixed");
  assert.equal(briefs.filter((brief) => brief.task === "build").length, 3);
  assert.equal(briefs.filter((brief) => brief.task === "review").length, 3);
  const events = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const repairsReturned = events.filter(
    (event) => event.type === "tool_execution_end" && event.toolName === "pinata_repair",
  );
  assert.equal(repairsReturned.length, 2);
  assert(repairsReturned.every((event) => event.result.details.result.background === true));
  const notices = events.filter(
    (event) => event.type === "message_end" && event.message?.customType === "pinata-actionable",
  );
  assert.equal(notices.length, 2);
  assert.notEqual(notices[0].message.details[0].noticeId, notices[1].message.details[0].noticeId);
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
    !result.stdout.includes('"customType":"pinata-result"'),
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
            limits: { jobMs: 60_000, taskMs: 60_000 },
          },
          tasks: [
            {
              id: "build",
              role: "builder",
              task: "Run the fixture shell",
              ownership: ["worker.pid"],
              noChecksReason: "timeout fixture",
            },
          ],
          noIntegratedChecksReason: "timeout fixture",
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
    const files = await readdir(worktrees, { recursive: true });
    const marker = files.find((file) => file.endsWith("worker.pid"));
    assert(marker, "the worker shell ran before timeout");
    const pid = Number(await readFile(join(worktrees, marker), "utf8"));
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
