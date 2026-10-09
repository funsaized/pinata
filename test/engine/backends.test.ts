// Backend conformance (E6.1): the same behaviours, checked for the in-process backend (Pi SDK
// sessions) and the process backend (`pi --mode rpc` children).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
        checks: [],
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
    for (const secret of ["deadline", "maxTurns", "taskDigest", "attemptDir", "runId", "limits"])
      assert(!brief.includes(secret), `brief mentions ${secret}`);
  });

  test(`${kind}: a missing result gets one reminder in the same session, then fails`, async (t) => {
    let reminded = 0;
    const world = await make(t, (turn) => {
      if (turn.text.includes("You have not called submit_result yet")) {
        reminded++;
        return turn.agent === "late" ? submit(turn) : { text: "Still nothing." };
      }
      return { text: "I looked around." };
    });
    const view = await (await world.run([spec("late"), spec("never")])).done;
    assert.equal(view.agents.late.status, "succeeded");
    assert.equal(view.agents.never.status, "failed");
    assert.match(view.agents.never.summary!, /without calling submit_result/);
    assert.equal(reminded, 2);
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

  test(`${kind}: budgets stop turns, tool calls, cost and wall clock`, async (t) => {
    const loop: Script = () => ({
      toolCalls: [{ name: "read", arguments: { path: "README.md" } }],
    });
    const world = await make(t, loop);
    let view = await (await world.run([spec("a")], { limits: { maxTurns: 3 } })).done;
    assert.equal(view.agents.a.reason, "turn budget exceeded");
    view = await (await world.run([spec("b")], { limits: { maxToolCalls: 2 } })).done;
    assert.equal(view.agents.b.reason, "tool call budget exceeded");
    const priced = await make(t, loop, { priced: true });
    view = await (await priced.run([spec("c")], { limits: { costUsd: 1 } })).done;
    assert.equal(view.agents.c.status, "failed");
    assert.equal(view.agents.c.reason, "cost limit reached");
    assert.equal(view.status, "cancelled");
    assert(view.agents.c.usage.cost > 1);
    const slow = await make(t, async (turn) => {
      await new Promise((r) => setTimeout(r, 300));
      return loop(turn);
    });
    view = await (await slow.run([spec("d")], { limits: { taskMs: 100 } })).done;
    assert.equal(view.agents.d.status, "failed");
    assert.equal(view.agents.d.reason, "deadline exceeded");
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
    assert.deepEqual(roles.slice(0, 3), ["user", "assistant", "toolResult"]);
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
        ? [JSON.parse(await readFile(join(handle.dir, "agents", "stuck", "pid.json"), "utf8")).pid]
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

for (const [kind, make] of worlds) {
  test(`${kind}: a builder writes in its worktree within ownership, and its reviewer approves`, async (t) => {
    const world = await make(
      t,
      (turn) => {
        if (turn.role === "builder") {
          if (turn.round === 0)
            return {
              toolCalls: [
                { name: "write", arguments: { path: "a.txt", content: "new\n" } },
                { name: "write", arguments: { path: "b.txt", content: "not mine\n" } },
              ],
            };
          assert.match(turn.text, /outside this builder's ownership/);
          return submit(turn, { changedFiles: ["a.txt"] });
        }
        return submit(turn, { review: { verdict: "approve" } });
      },
      { files: { "a.txt": "old\n", "b.txt": "old\n" } },
    );
    const handle = await world.run(
      [
        spec("build", "builder", { ownership: ["a.txt"], noChecksReason: "fixture" }),
        spec("review", "reviewer", { reviewOf: "build", after: ["build"] }),
      ],
      { allowWrites: true },
    );
    const view = await handle.done;
    assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
    assert.equal(view.agents.build.workspace?.kind, "worktree");
    const saved = JSON.parse(await readFile(join(handle.dir, "results", "build.json"), "utf8"));
    assert.deepEqual(
      saved.data.changes.changes.map((c: { path: string }) => c.path),
      ["a.txt"],
    );
    assert.equal(
      await readFile(join(world.repo, "a.txt"), "utf8"),
      "old\n",
      "the checkout is untouched",
    );
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
