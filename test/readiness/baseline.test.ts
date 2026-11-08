// Known failures are assertions about baseline d1c386f, not desired v3 behavior.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ContextFileCache } from "../../engine/backends/in-process.ts";
import { FakeBackend, fakeResult } from "../../engine/backends/fake.ts";
import { basicPipeline, createEngine, type RunContext } from "../../engine/core/engine.ts";
import { ZERO_USAGE, type AgentEvent } from "../../engine/core/types.ts";
import { emptyView, reduce } from "../../engine/core/view.ts";
import { PinataHost } from "../../engine/pi/host.ts";
import { registerTools } from "../../engine/pi/tools.ts";
import { readRunRecord } from "../../engine/verify/integrate.ts";
import { liveFingerprint } from "../../engine/workspace/live.ts";
import { mood } from "../../engine/ui/mascot.ts";
import { collectNativeEvidence } from "../../arena/native-evidence.ts";
import { fauxWorld, gitRepo } from "../engine/faux.ts";
import { spec, tempDir } from "../engine/helpers.ts";

export function probeHost() {
  const pi = {
    getSettings: () => ({}),
    getThinkingLevel: () => "off",
    getAllTools: () => [],
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  return new PinataHost(pi);
}

test("baseline F3: a rejected reference reserves durable metadata and blocks corrected retry", async (t) => {
  const world = await fauxWorld(t, () => fauxAssistantMessage([fauxText("done")]));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = world.agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const host = probeHost();
  t.after(() => host.shutdown("readiness cleanup"));
  const ctx = {
    cwd: world.repo,
    modelRegistry: world.registry,
    model: world.registry.find("faux", "faux-1"),
  } as unknown as ExtensionContext;
  const { handle } = await host.start(
    { tasks: [spec("base")], config: { setup: false, codemode: false } },
    ctx,
  );
  await handle.done;
  await assert.rejects(
    host.start(
      {
        run: handle.id,
        tasks: [spec("audit", "scout", { after: [{ worker: "base", assignment: 999 }] })],
        config: { setup: false },
      },
      ctx,
    ),
    /Unknown assignment base\/999/,
  );
  const record = await readRunRecord(handle.dir);
  assert.deepEqual(
    record.tasks.map((task) => task.id),
    ["base", "audit"],
  );
  assert.deepEqual(handle.view().order, ["base"]);
  await assert.rejects(
    host.start(
      {
        run: handle.id,
        tasks: [spec("audit", "scout", { after: ["base"] })],
        config: { setup: false },
      },
      ctx,
    ),
    /Duplicate worker audit/,
  );
  t.diagnostic(
    JSON.stringify({ probe: "F3", rejectedWorkerPersisted: true, correctedRetryRejected: true }),
  );
});

test("baseline F4: next wait ignores an active assignment when its follow-up is queued", async (t) => {
  const tools = new Map<string, ToolDefinition>();
  let listener: ((event: AgentEvent) => void) | undefined;
  let sequence = 0;
  let view = emptyView("probe");
  const emit = (body: Record<string, unknown>) => {
    const event = { v: 2, seq: sequence++, at: 0, run: "probe", ...body } as AgentEvent;
    view = reduce(view, event);
    listener?.(event);
  };
  const task = spec("a");
  emit({ t: "run_started", tasks: [task], mode: "lean" });
  emit({ t: "agent_queued", agent: "a", assignment: 1, task, dependencies: [] });
  emit({
    t: "agent_started",
    agent: "a",
    assignment: 1,
    backend: "fake",
    model: { provider: "fake", id: "fake" },
    workspace: { kind: "live", path: "." },
  });
  emit({
    t: "agent_queued",
    agent: "a",
    assignment: 2,
    task,
    dependencies: [{ worker: "a", assignment: 1 }],
  });
  const handle = { id: "probe", dir: "/fixture", view: () => view, results: () => new Map() };
  registerTools(
    {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI,
    {
      find: async () => ({ handle }),
      subscribe: (_id: string, receive: (event: AgentEvent) => void) => {
        listener = receive;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as PinataHost,
  );
  let returned = false;
  const wait = tools.get("pinata_wait");
  assert(wait);
  const waiting = wait
    .execute("probe", { run: "probe", next: true }, undefined, undefined, {
      cwd: "/fixture",
    } as ExtensionToolContext)
    .then(() => {
      returned = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  emit({
    t: "agent_settled",
    agent: "a",
    assignment: 1,
    status: "succeeded",
    summary: "first",
    usage: ZERO_USAGE,
    turns: 1,
    toolCalls: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  emit({
    t: "agent_settled",
    agent: "a",
    assignment: 2,
    status: "succeeded",
    summary: "second",
    usage: ZERO_USAGE,
    turns: 1,
    toolCalls: 0,
  });
  await waiting;
  assert.equal(returned, true);
  t.diagnostic(JSON.stringify({ probe: "F4", afterFirst: false, afterSecond: true }));
});

test("baseline F5: mixed message coverage yields an incomplete known total", async (t) => {
  const cwd = await tempDir(t, "pinata-readiness-usage-");
  const evidenceDir = join(cwd, "evidence");
  const run = join(cwd, ".git/pinata/11111111-1111-1111-1111-111111111111");
  await mkdir(evidenceDir);
  await mkdir(run, { recursive: true });
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.2 };
  await writeFile(
    join(evidenceDir, "native.stdout.jsonl"),
    [
      {
        type: "message_end",
        message: { role: "assistant", responseId: "r", usage: { ...usage, cost: { total: 0.2 } } },
      },
      { type: "agent_end" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  await writeFile(
    join(run, "events.jsonl"),
    [
      {
        t: "agent_started",
        seq: 1,
        agent: "a",
        assignment: 1,
        backend: "in-process",
        workspace: { kind: "live" },
      },
      {
        t: "agent_started",
        seq: 2,
        agent: "b",
        assignment: 1,
        backend: "in-process",
        workspace: { kind: "live" },
      },
      { t: "message_end", seq: 3, agent: "a", assignment: 1, usage },
      { t: "agent_settled", seq: 4, agent: "a", assignment: 1, status: "succeeded", usage },
      {
        t: "agent_settled",
        seq: 5,
        agent: "b",
        assignment: 1,
        status: "succeeded",
        usage: { ...usage, input: 1000, cost: 10 },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  const evidence = await collectNativeEvidence(
    {
      cwd,
      evidenceDir,
      model: { provider: "fixture", id: "fixture", version: null, settings: {} },
    },
    "pinata",
  );
  assert.equal(evidence.usage.inputTokens, 20);
  assert.equal(evidence.usage.costUsd, 0.4);
  t.diagnostic(
    JSON.stringify({
      probe: "F5",
      reportedInput: 20,
      observedCompleteInput: 1020,
      reportedCost: 0.4,
      observedCompleteCost: 10.4,
    }),
  );
});

test("baseline F6/F7: instruction discovery and content freshness miss additions/dirty edits", async (t) => {
  const directory = await tempDir(t, "pinata-readiness-freshness-");
  const cwd = join(directory, "repo");
  const agent = join(directory, "agent");
  await mkdir(agent);
  const repo = gitRepo(cwd, { "a.txt": "base\n" });
  await repo.init();
  const cache = new ContextFileCache();
  cache.get(cwd, agent);
  await writeFile(join(cwd, "AGENTS.md"), "New instruction");
  assert.equal(
    cache.get(cwd, agent).some((entry) => entry.path === join(cwd, "AGENTS.md")),
    false,
  );
  assert.equal(
    new ContextFileCache().get(cwd, agent).some((entry) => entry.path === join(cwd, "AGENTS.md")),
    true,
  );
  await writeFile(join(cwd, "a.txt"), "first\n");
  const first = await liveFingerprint(cwd);
  await writeFile(join(cwd, "a.txt"), "second\n");
  assert.equal(await liveFingerprint(cwd), first);
  t.diagnostic(
    JSON.stringify({
      probe: "F6/F7",
      warmMissesNewInstruction: true,
      dirtyContentChangeMissed: true,
    }),
  );
});

test("baseline F8: isolated completion is labeled reviewed without a review", (t) => {
  const task = spec("build", "builder", { workspace: "worktree" });
  let view = emptyView("probe");
  const events = [
    { t: "run_started", tasks: [task], mode: "lean" },
    {
      t: "agent_started",
      agent: "build",
      backend: "fake",
      model: { provider: "fake", id: "fake" },
      workspace: { kind: "worktree", path: "." },
    },
    {
      t: "agent_settled",
      agent: "build",
      status: "succeeded",
      summary: "done",
      usage: ZERO_USAGE,
      turns: 1,
      toolCalls: 0,
    },
  ];
  events.forEach((body, seq) => {
    view = reduce(view, { v: 2, seq, at: seq, run: "probe", ...body } as AgentEvent);
  });
  assert.match(mood(view).text, /reviews complete/);
  t.diagnostic(JSON.stringify({ probe: "F8", reviewEvidence: false, text: mood(view).text }));
});

test("baseline A1: two dependencies from one worker retain only the later result in the payload", async (t) => {
  const directory = await tempDir(t, "pinata-readiness-dependencies-");
  const backend = new FakeBackend((launch) => ({
    result: fakeResult({ summary: `result-${launch.assignment}` }),
  }));
  const pipeline = basicPipeline({ backend: "fake" });
  let observation: { references: RunContext["dependencies"]; results: number[] } | undefined;
  const engine = createEngine({
    backends: { fake: backend },
    pipeline: {
      ...pipeline,
      async prepare(run, task, signal) {
        if (task.id === "dependent")
          observation = {
            references: run.dependencies,
            results: [...run.results.values()].map((result) => result.assignment ?? 0),
          };
        return pipeline.prepare(run, task, signal);
      },
    },
  });
  t.after(() => engine.shutdown("readiness cleanup"));
  const handle = await engine.run([spec("base")], { cwd: directory, dir: join(directory, "run") });
  await handle.done;
  await engine.steer(handle.id, "base", "second", "followUp", "user", "second");
  await handle.done;
  await engine.add(handle.id, [
    spec("dependent", "scout", {
      after: [
        { worker: "base", assignment: 1 },
        { worker: "base", assignment: 2 },
      ],
    }),
  ]);
  await handle.done;
  assert(observation);
  assert.equal(observation.references?.length, 2);
  assert.deepEqual(observation.results, [2]);
  assert.match(await readFile(join(handle.dir, "results/base/1.json"), "utf8"), /result-1/);
  t.diagnostic(JSON.stringify({ probe: "A1", ...observation }));
});
