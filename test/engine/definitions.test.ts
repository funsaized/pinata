import { compactRun } from "../../engine/pi/host.ts";
import { PreparationGate } from "../../engine/workspace/preparation.ts";
import assert from "node:assert/strict";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents, resolveTasks } from "../../engine/pi/definitions.ts";
import { validateDefinition, validateSnapshots, taskSpec } from "../../engine/core/definitions.ts";
import { validateGraph } from "../../engine/core/validate.ts";
import { validateResult } from "../../engine/core/results.ts";
import { modelCandidates, validateConfig } from "../../engine/pi/config.ts";
import { resolveToolExtensions, validateToolExtensions } from "../../engine/pi/tool-providers.ts";
import { brief, DEPENDENCIES_CAP } from "../../engine/agent/brief.ts";
import { tempDir, fakeEngine } from "./helpers.ts";
import { fakeResult } from "../../engine/backends/fake.ts";
import { Limiter } from "../../engine/core/limiter.ts";

const definition = (name = "analyst", workspace = "live-readonly", tools = ["read"]) =>
  validateDefinition(
    {
      schemaVersion: 1,
      name,
      description: "Test agent",
      workspace,
      tools,
      prompt: "Inspect the evidence.",
    },
    "fixture",
  );

test("only three presets; optional examples install through the same loader", async (t) => {
  const root = await tempDir(t);
  const personal = join(root, "personal");
  assert.deepEqual([...discoverAgents(root, personal).keys()].sort(), [
    "builder",
    "reviewer",
    "scout",
  ]);
  assert.throws(
    () =>
      resolveTasks([{ id: "p", role: "planner", task: "Plan" }], discoverAgents(root, personal)),
    /optional example/,
  );
  const directory = join(root, ".pi", "pinata", "agents");
  await mkdir(directory, { recursive: true });
  for (const name of ["planner", "researcher"])
    await copyFile(
      new URL(`../../examples/agents/${name}.md`, import.meta.url),
      join(directory, `${name}.md`),
    );
  const agents = discoverAgents(root, personal);
  assert.equal(agents.size, 5);
  const resolved = resolveTasks([{ id: "p", agent: "planner", task: "Plan" }], agents);
  const [task] = validateGraph(resolved.tasks, { definitions: resolved.definitions });
  assert.equal(task.definition?.workspace, "live-readonly");
  assert.equal(taskSpec(task).definition, task.definition?.digest);
});

test("definitions reject unsafe combinations and snapshots detect mutation", () => {
  assert.deepEqual(definition("thinker", "live-readonly", []).tools, []);
  assert.throws(() => definition("reader", "live-readonly", ["bash"]), /requires a worktree/);
  assert.throws(() => definition("recursive", "worktree", ["pinata_run"]), /invalid tool/);
  const agent = definition();
  assert.throws(
    () => validateSnapshots({ [agent.digest]: { ...agent, prompt: "changed" } }),
    /changed/,
  );
  assert.throws(
    () =>
      resolveTasks(
        [{ id: "a", agent: "analyst", task: "Inspect", definition: agent.digest }],
        new Map([[agent.name, agent]]),
      ),
    /assigned by Pinata/,
  );
});

test("repository definitions replace personal defaults; duplicates and preset overrides fail", async (t) => {
  const root = await tempDir(t);
  const personal = join(root, "personal");
  const userDirectory = join(personal, "pinata", "agents");
  const projectDirectory = join(root, ".pi", "pinata", "agents");
  for (const dir of [userDirectory, projectDirectory]) await mkdir(dir, { recursive: true });
  const content = (name: string, prompt: string) =>
    `---\nschemaVersion: 1\nname: ${name}\ndescription: Test\nworkspace: live-readonly\ntools: []\n---\n${prompt}\n`;
  await writeFile(join(userDirectory, "analyst.md"), content("analyst", "Personal"));
  const project = join(projectDirectory, "analyst.md");
  await writeFile(project, content("analyst", "Project"));
  const chosen = discoverAgents(root, personal).get("analyst")!;
  assert.equal(chosen.prompt, "Project");
  await writeFile(project, content("analyst", "Changed"));
  assert.notEqual(discoverAgents(root, personal).get("analyst")!.digest, chosen.digest);
  assert.equal(chosen.prompt, "Project", "discovery does not mutate previous snapshots");
  const duplicate = join(projectDirectory, "duplicate.md");
  await writeFile(duplicate, content("analyst", "Duplicate"));
  assert.throws(() => discoverAgents(root, personal), /duplicate agent analyst/);
  await rm(duplicate);
  await writeFile(project, content("scout", "Override"));
  assert.throws(() => discoverAgents(root, personal), /reserved preset/);
});

test("custom writers and reviewers obey ownership, authorization and review binding", () => {
  const writer = definition("implementer", "worktree", ["read", "write"]);
  const reviewer = definition("auditor", "review-target");
  const resolved = resolveTasks(
    [
      {
        id: "build",
        agent: "implementer",
        task: "Implement",
        ownership: ["src"],
        noChecksReason: "fixture",
      },
      { id: "review", agent: "auditor", task: "Review", reviewOf: "build", after: ["build"] },
    ],
    new Map([
      [writer.name, writer],
      [reviewer.name, reviewer],
    ]),
  );
  assert.throws(
    () => validateGraph(resolved.tasks, { definitions: resolved.definitions }),
    /approval/,
  );
  const tasks = validateGraph(resolved.tasks, {
    definitions: resolved.definitions,
    allowWrites: true,
  });
  assert.equal(tasks[0].definition?.name, "implementer");
  const result = validateResult(fakeResult({ review: { verdict: "approve" } as never }), {
    role: "auditor",
    definition: reviewer,
    reviewTarget: { taskId: "build", fingerprint: "exact" },
  });
  assert.equal(result.review?.fingerprint, "exact");
  assert.throws(
    () =>
      validateResult(fakeResult({ review: { verdict: "approve", fingerprint: "old" } as never }), {
        role: "auditor",
        definition: reviewer,
        reviewTarget: { taskId: "build", fingerprint: "exact" },
      }),
    /must be exact/,
  );
});

test("model precedence and local source output work for custom names", () => {
  const model = (id: string) => ({ provider: "faux", id, thinking: "off" as const });
  const agent = { ...definition(), model: model("profile") };
  const config = validateConfig({ models: { default: model("default") } }).config;
  assert.equal(
    modelCandidates(config, "analyst", undefined, model("session"), agent)[0].model?.id,
    "profile",
  );
  config.models.analyst = model("configured");
  assert.equal(
    modelCandidates(config, "analyst", undefined, undefined, agent)[0].model?.id,
    "configured",
  );
  assert.equal(
    modelCandidates(config, "analyst", model("task"), undefined, agent)[0].model?.id,
    "task",
  );
  const result = validateResult(
    fakeResult({
      sources: [
        {
          path: "src/cache.ts",
          title: "Cache",
          supports: "Invalidation",
          applicability: "Current checkout",
        },
      ],
    }),
    { role: agent.name, definition: agent },
  );
  assert.equal(result.sources?.[0].path, "src/cache.ts");
  assert.deepEqual(
    validateResult(fakeResult({ sources: [] }), {
      role: agent.name,
      definition: agent,
    }).sources,
    [],
    "optional sources may be empty",
  );
  assert.throws(
    () =>
      validateResult(fakeResult({ sources: [] }), {
        role: agent.name,
        definition: { ...agent, output: { require: ["sources"] } },
      }),
    /at least one source/,
  );
  assert.throws(
    () =>
      validateResult(fakeResult({ data: { large: "x".repeat(128 * 1024) } }), {
        role: agent.name,
        definition: agent,
      }),
    /128 KiB/,
  );
});

test("extension requirements fail before dispatch and detect changed entry files", async (t) => {
  const root = await tempDir(t);
  const path = join(root, "extension.ts");
  await writeFile(path, "export default () => {};");
  const config = validateConfig({
    toolProviders: { local: { extension: path, tools: ["lookup"] } },
  }).config;
  assert.throws(() => resolveToolExtensions(["missing"], config, null, root), /unavailable/);
  const extensions = resolveToolExtensions(["read", "lookup"], config, null, root);
  assert.equal(extensions.length, 1);
  validateToolExtensions(extensions);
  await writeFile(path, "export default () => { throw Error('changed'); };");
  assert.throws(() => validateToolExtensions(extensions), /changed since/);
});

test("dependency fan-in stays bounded and points to complete evidence", () => {
  const [task] = validateGraph([
    { id: "read", role: "scout", task: "Read", acceptance: ["Evidence"] },
  ]);
  const prompt = brief({
    task,
    workspace: { kind: "live", path: "/repo" },
    dependencies: Array.from({ length: 1000 }, (_, i) => ({
      id: `t-${i}`,
      role: "scout",
      status: "succeeded",
      summary: "x".repeat(8000),
      result: null,
      path: `/run/results/t-${i}.json`,
    })),
  });
  assert(Buffer.byteLength(prompt) < DEPENDENCIES_CAP + 2048);
  assert.match(prompt, /further dependency results omitted/);
});

test("dispatch is fair across runs with 1000 queued tasks", async (t) => {
  const { backend, run } = await fakeEngine(t, () => ({ latencyMs: 2, result: fakeResult() }), {
    limiter: new Limiter({ cap: 1, initial: 1 }),
  });
  const large = await run(
    Array.from({ length: 1000 }, (_, i) => ({
      id: `task-${i}`,
      role: "scout",
      task: "Inspect",
      acceptance: ["Evidence"],
    })),
  );
  const small = await run([
    { id: "small", role: "scout", task: "Inspect", acceptance: ["Evidence"] },
  ]);
  assert.equal((await small.done).status, "succeeded");
  assert(
    backend.starts.findIndex((s) => s.task === "small") < 5,
    "small run must not wait behind the entire burst",
  );
  assert.equal((await large.done).status, "succeeded");
});

test("worktree preparation is bounded and cancelled queued work never starts", async () => {
  const gate = new PreparationGate(1);
  let finish!: () => void;
  const first = gate.run(
    new AbortController().signal,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  let started = false;
  const cancelled = gate.run(controller.signal, async () => {
    started = true;
  });
  controller.abort(new Error("cancel queued setup"));
  await assert.rejects(cancelled, /cancel queued setup/);
  finish();
  await first;
  assert.equal(started, false);
  assert.equal(await gate.run(new AbortController().signal, async () => 42), 42);
});

test("large results paginate within the context budget without hiding task counts", async (t) => {
  const { run } = await fakeEngine(t, () => ({
    result: fakeResult({ summary: "A".repeat(1600), brief: "B".repeat(8000) }),
  }));
  const handle = await run(
    Array.from({ length: 80 }, (_, i) => ({ id: `task-${i}`, agent: "scout", task: "Inspect" })),
  );
  const view = await handle.done;
  const seen: string[] = [];
  let offset = 0;
  for (;;) {
    const page = compactRun(view, handle.dir, handle.results(), [], { offset });
    assert.equal(page.taskCount, 80);
    assert.equal(page.counts.succeeded, 80);
    assert(Buffer.byteLength(JSON.stringify(page.tasks)) < 33 * 1024);
    seen.push(...page.tasks.map((task) => task.id));
    if (page.nextOffset === undefined) break;
    assert(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.deepEqual(seen, view.order);
});
