import { readDefinition, resolveTasks } from "../../engine/pi/definitions.ts";
import { resolveToolExtensions } from "../../engine/pi/tool-providers.ts";
import { validateConfig } from "../../engine/pi/config.ts";
// Backend conformance (E6.1): the same behaviours, checked for the in-process backend (Pi SDK
// sessions) and the process backend (`pi --mode rpc` children).
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spec } from "./helpers.ts";
import {
  herdrAvailable,
  herdrWorld,
  inProcessWorld,
  processWorld,
  type Reply,
  type Script,
  type Turn,
} from "./worlds.ts";

const submit = (turn: Turn, extra: Record<string, unknown> = {}): Reply => ({
  toolCalls: [
    {
      name: "submit_result",
      arguments: {
        status: "succeeded",
        summary: `${turn.agent} done`,
        changedFiles: [],

        findings: [],
        blockers: [],
        ...(turn.role !== "builder" &&
          turn.role !== "reviewer" && { brief: `${turn.agent} brief` }),
        ...extra,
      },
    },
  ],
});

const reader: Script = (turn) =>
  turn.round === 0
    ? {
        toolCalls: [
          { name: "read", arguments: { path: "README.md" } },
          { name: "ls", arguments: { path: "." } },
        ],
      }
    : submit(turn);

// Detached agents (survive: true) run `pi --mode json` with files instead of pipes.
const detachedWorld: typeof processWorld = async (t, script, options) => {
  const world = await processWorld(t, script, options);
  return {
    ...world,
    kind: "process",
    run: (tasks, opts = {}) => world.run(tasks, { ...opts, data: { ...opts.data, survive: true } }),
  };
};

const worlds = [
  ["in-process", inProcessWorld],
  ["process", processWorld],
  ["detached", detachedWorld],
  // Only inside Herdr (never on CI): agents in Herdr panes that the tests create and close.
  ...(herdrAvailable() ? ([["herdr-pi", herdrWorld]] as const) : []),
] as const;

for (const [kind, make] of worlds) {
  test(`${kind}: readers run with their role loadout and submit through submit_result`, async (t) => {
    const world = await make(t, reader);
    const handle = await world.run([spec("scout"), spec("plan", "planner", { after: ["scout"] })]);
    const view = await handle.done;
    assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
    assert.equal(view.agents.scout.backend, kind === "detached" ? "process" : kind);
    const first = (id: string) => world.turns.find((x) => x.agent === id)!;
    assert.deepEqual(first("scout").tools, ["find", "grep", "ls", "read", "submit_result"]);
    assert.equal(view.agents.scout.turns, 2);
    assert.equal(view.agents.scout.toolCalls, 3, "read, ls, submit_result");
    const saved = JSON.parse(await readFile(join(handle.dir, "results", "scout.json"), "utf8"));
    assert.equal(saved.result.brief, "scout brief");
    assert.match(first("plan").text, /"task":"scout","role":"scout","status":"succeeded"/);
    const transcript = (await readFile(join(handle.dir, "transcripts", "scout.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert(transcript.length >= 4, `transcript lines: ${transcript.length}`);
  });
}

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

async function until(condition: () => boolean, what: string) {
  const end = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const [kind, make] of worlds) {
  test(`${kind}: codemode is in the loadout when enabled`, async (t) => {
    const world = await make(t, reader);
    const view = await (await world.run([spec("scout")], { data: { codemode: true } })).done;
    assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
    assert.deepEqual(world.turns[0].tools, [
      "codemode",
      "find",
      "grep",
      "ls",
      "read",
      "submit_result",
    ]);
  });

  test(`${kind}: siblings get byte-identical system prompts; briefs hold no supervisor state`, async (t) => {
    const world = await make(t, reader);
    await (
      await world.run([spec("a"), spec("b"), spec("c", "planner")])
    ).done;
    const sys = (id: string) => world.turns.find((x) => x.agent === id)!.system;
    assert.equal(sys("a"), sys("b"));
    assert.notEqual(sys("a"), sys("c"));
    assert.match(sys("a"), /You are pinata's scout/);
    assert.match(sys("a"), /# pinata agent contract/);
    const brief = world.turns.find((x) => x.agent === "a")!.text;
    for (const secret of ["deadline", "maxTurns", "taskDigest", "attemptDir", "runId"])
      assert(!brief.includes(secret), `brief mentions ${secret}`);
  });

  test(`${kind}: invalid submissions return an error the model can fix`, async (t) => {
    const world = await make(t, (turn) => {
      if (turn.round === 0) return submit(turn, { brief: undefined, blockers: ["x"] });
      assert.match(turn.text, /submit_result rejected: A succeeded result cannot list blockers/);
      return submit(turn);
    });
    const view = await (await world.run([spec("s")])).done;
    assert.equal(view.agents.s.status, "succeeded", JSON.stringify(view.agents));
  });

  test(`${kind}: steering reaches a running agent; snapshots show its history mid-run`, async (t) => {
    const paused = gate();
    let waiting = false;
    const world = await make(t, async (turn) => {
      if (turn.round === 0)
        return { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] };
      if (turn.round === 1) {
        waiting = true;
        await paused.opened;
        return { toolCalls: [{ name: "ls", arguments: { path: "." } }] };
      }
      return submit(turn);
    });
    const handle = await world.run([spec("scout")]);
    await until(() => waiting, "the second turn");
    const snapshot = await world.engine.snapshot(handle.id, "scout");
    assert(snapshot, "a running agent has a snapshot");
    const roles = (snapshot.messages as Array<{ role: string }>)
      .map((m) => m.role)
      .filter((r) => r !== "system");
    assert(roles.includes("custom"));
    assert(roles.includes("assistant"));
    assert(roles.includes("toolResult"));
    await world.engine.steer(handle.id, "scout", "Mention the README title", "steer", "user");
    paused.open();
    const view = await handle.done;
    assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
    const after = world.turns.filter((x) => x.agent === "scout").at(-1)!;
    assert.match(after.text, /Mention the README title/);
    assert.deepEqual(
      view.agents.scout.steers.map((s) => s.text),
      ["Mention the README title"],
    );
  });

  test(`${kind}: cancelling a running agent stops it, with nothing left running`, async (t) => {
    const paused = gate();
    t.after(() => paused.open());
    let waiting = false;
    const world = await make(t, async () => {
      waiting = true;
      await paused.opened;
      return { text: "late" };
    });
    const handle = await world.run([spec("stuck")]);
    await until(() => waiting, "the first request");
    const pids =
      kind === "herdr-pi"
        ? [
            JSON.parse(await readFile(join(handle.dir, "agents", "stuck", "1", "pid.json"), "utf8"))
              .pid,
          ]
        : [...(world.backend?.children.values() ?? [])].map((c) => c.pid);
    if (kind !== "in-process") assert.equal(pids.length, 1);
    await world.engine.cancel(handle.id, undefined, "cancelled by the test");
    // The faux provider finishes its response before it sees the abort.
    paused.open();
    const view = await handle.done;
    assert.equal(view.agents.stuck.status, "cancelled");
    for (const pid of pids) await until(() => !alive(pid), `pid ${pid} to exit`);
    assert.equal(world.backend?.children.size ?? 0, 0);
  });
}

test("backend selection: in-process by default, then config, then the task; survive needs processes", async () => {
  const { selectBackend } = await import("../../engine/pi/pipeline.ts");
  const { validateConfig } = await import("../../engine/pi/config.ts");
  const config = validateConfig({}).config;
  assert.equal(config.backend, "in-process");
  assert.equal(selectBackend(undefined, config), "in-process");
  assert.equal(selectBackend(undefined, { backend: "process" }), "process");
  assert.equal(selectBackend("in-process", { backend: "process" }), "in-process", "task wins");
  assert.equal(selectBackend("herdr-pi", { backend: "in-process" }), "herdr-pi");
  assert.equal(selectBackend(undefined, { backend: "in-process", survive: true }), "process");
  assert.equal(selectBackend("in-process", { backend: "in-process", survive: true }), "process");
  assert.equal(selectBackend("herdr-pi", { backend: "in-process", survive: true }), "herdr-pi");
  assert.throws(() => validateConfig({ backend: "thread" }), /backend must be one of/);
});

for (const [kind, make] of worlds) {
  test(`${kind}: optional researcher loads declared extension tools and submits local sources`, async (t) => {
    const world = await make(t, (turn) =>
      turn.round === 0
        ? { toolCalls: [{ name: "web_search", arguments: { query: "fixture" } }] }
        : submit(turn, {
            sources: [
              {
                path: "README.md",
                title: "Local source",
                supports: "Fixture exists",
                applicability: "Current checkout",
              },
            ],
          }),
    );
    const extension = join(world.repo, "fixture-web.ts");
    const tools = ["web_enable", "web_search", "fetch_content", "get_search_content"];
    await writeFile(
      extension,
      `export default function(pi) { for (const name of ${JSON.stringify(tools)}) pi.registerTool({ name, label: name, description: 'Fixture search', parameters: { type: 'object', properties: { query: { type: 'string' } } }, async execute() { return { content: [{ type: 'text', text: 'Local source: README.md' }], details: {} }; } }); }`,
    );
    const definition = readDefinition(
      fileURLToPath(new URL("../../examples/agents/researcher.md", import.meta.url)),
    );
    const resolved = resolveTasks(
      [{ id: "research", agent: "researcher", task: "Find local evidence" }],
      new Map([[definition.name, definition]]),
    );
    const extensions = resolveToolExtensions(
      definition.tools,
      validateConfig({ webExtension: extension }).config,
      extension,
      world.repo,
    );
    const handle = await world.run(resolved.tasks, {
      data: { definitions: resolved.definitions, toolExtensions: extensions },
    });
    assert.equal((await handle.done).status, "succeeded", JSON.stringify(handle.view().agents));
    assert(world.turns[0].tools.includes("web_search"));
    assert(!world.turns[0].tools.includes("bash"));
    assert.equal(handle.results().get("research")?.result?.sources?.[0].path, "README.md");
  });
}

for (const [kind, make] of worlds) {
  test(`${kind}: final text, durable message consumption and restored follow-up context`, async (t) => {
    const world = await make(t, (turn) => ({
      text:
        turn.round === 0
          ? "Remember the first assignment"
          : "Second assignment retained the first context",
    }));
    const handle = await world.run([spec("worker")]);
    await handle.done;
    assert.equal(handle.results().get("worker")?.summary, "Remember the first assignment");
    const receipt = await world.engine.steer(
      handle.id,
      "worker",
      "Continue the second assignment",
      "followUp",
      "parent",
      "continuation-id",
    );
    assert.equal(receipt.target.assignment, 2);
    await handle.done;
    const retry = await world.engine.steer(
      handle.id,
      "worker",
      "Continue the second assignment",
      "followUp",
      "parent",
      "continuation-id",
    );
    assert.equal(retry.target.assignment, 2);
    assert.equal(retry.state, "consumed");
    assert.match(retry.checkpoint!, /conversation\.jsonl#/);
    assert.equal(world.turns.length, 2);
    assert.match(world.turns[1].text, /Remember the first assignment/);
    const first = JSON.parse(
      await readFile(join(handle.dir, "results", "worker", "1.json"), "utf8"),
    );
    assert.equal(first.summary, "Remember the first assignment");
  });
}

for (const [kind, make] of worlds) {
  test(`${kind}: explicit continuation restores context after cancellation`, async (t) => {
    const paused = gate();
    const entered = gate();
    t.after(paused.open);
    const world = await make(t, async (turn) => {
      if (turn.round === 0) return { text: "Original durable context" };
      if (turn.round === 1) {
        entered.open();
        await paused.opened;
      }
      return { text: "Continued explicitly" };
    });
    const handle = await world.run([spec("worker")]);
    await handle.done;
    await world.engine.steer(handle.id, "worker", "Interrupted assignment marker", "followUp");
    await entered.opened;
    await world.engine.cancel(handle.id, "worker", "explicit cancellation");
    paused.open();
    await handle.done;
    assert.equal(handle.view().agents.worker.status, "cancelled");
    await world.engine.steer(handle.id, "worker", "Resume cancelled work explicitly", "followUp");
    await handle.done;
    assert.equal(handle.view().agents.worker.status, "succeeded");
    assert.equal(handle.view().agents.worker.assignment, 3);
    assert.match(world.turns.at(-1)!.text, /Original durable context/);
    assert.match(world.turns.at(-1)!.text, /Interrupted assignment marker/);
  });
}
