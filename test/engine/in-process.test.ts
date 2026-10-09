import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createChildRuntime } from "../../engine/pi/runtime.ts";
import type { AgentResult } from "../../engine/core/types.ts";
import { fauxWorld, MODEL, type FauxTurn } from "./faux.ts";
import { spec } from "./helpers.ts";

const submit = (
  turn: FauxTurn,
  extra: Partial<AgentResult> = {},
): ReturnType<typeof fauxAssistantMessage> =>
  fauxAssistantMessage(
    fauxToolCall("submit_result", {
      status: "succeeded",
      summary: `${turn.agent} done`,
      changedFiles: [],
      checks: [],
      findings: [],
      blockers: [],
      ...(turn.role !== "builder" && turn.role !== "reviewer" && { brief: `${turn.agent} brief` }),
      ...(turn.role === "research" && {
        sources: [{ url: "https://example.com", title: "t", supports: "s", applicability: "a" }],
      }),
      ...extra,
    } as Record<string, any>),
    { stopReason: "toolUse" },
  );

// One read round, then submit.
const reader = (turn: FauxTurn) =>
  turn.round === 0
    ? fauxAssistantMessage(
        [fauxToolCall("read", { path: "README.md" }), fauxToolCall("ls", { path: "." })],
        { stopReason: "toolUse" },
      )
    : submit(turn);

test("the child runtime replays an extension's provider; later readiness is under 1 ms", async (t) => {
  const world = await fauxWorld(t, reader);
  const child = await createChildRuntime(world.registry, world.agentDir);
  assert(child.getModel("faux", "faux-1"), "faux model replayed");
  await world.cache.get(world.registry);
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) await world.cache.get(world.registry);
  const each = (performance.now() - t0) / 100;
  assert(each < 1, `readiness ${each.toFixed(3)} ms`);
});

test("readers run in process with their role loadout and submit through submit_result", async (t) => {
  const world = await fauxWorld(t, reader);
  const handle = await world.run([
    spec("scout"),
    spec("plan", "planner", { after: ["scout"] }),
    spec("dig", "research"),
  ]);
  const view = await handle.done;
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  const first = (id: string) => world.turns.find((x) => x.agent === id)!;
  assert.deepEqual(first("scout").tools, ["find", "grep", "ls", "read", "submit_result"]);
  assert.deepEqual(first("plan").tools, ["find", "grep", "ls", "read", "submit_result"]);
  // Research's web tools come from pi-web-access, which this test does not load.
  assert.deepEqual(first("dig").tools, ["find", "grep", "ls", "read", "submit_result"]);
  assert.equal(view.agents.scout.turns, 2);
  assert.equal(view.agents.scout.toolCalls, 3, "read, ls, submit_result");
  const saved = JSON.parse(await readFile(join(handle.dir, "results", "scout.json"), "utf8"));
  assert.equal(saved.result.brief, "scout brief");
  // The planner's brief inlines the scout's result.
  assert.match(first("plan").text, /"task":"scout","role":"scout","status":"succeeded"/);
  // Lean mode writes the transcript once, at settle.
  const transcript = (await readFile(join(handle.dir, "transcripts", "scout.jsonl"), "utf8"))
    .trim()
    .split("\n");
  assert(transcript.length >= 4);
});

test("codemode is in the loadout when enabled", async (t) => {
  const world = await fauxWorld(t, reader);
  const view = await (await world.run([spec("scout")], { data: { codemode: true } })).done;
  assert.equal(view.status, "succeeded");
  assert.deepEqual(world.turns[0].tools, [
    "codemode",
    "find",
    "grep",
    "ls",
    "read",
    "submit_result",
  ]);
});

test("siblings of a role get byte-identical system prompts; briefs hold no supervisor state", async (t) => {
  const world = await fauxWorld(t, reader);
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

test("a missing result gets one reminder in the same session, then fails at the result stage", async (t) => {
  let reminded = 0;
  const world = await fauxWorld(t, (turn) => {
    if (turn.text.includes("You have not called submit_result yet")) {
      reminded++;
      return turn.agent === "late" ? submit(turn) : fauxAssistantMessage("Still nothing.");
    }
    return fauxAssistantMessage(fauxText("I looked around."));
  });
  const view = await (await world.run([spec("late"), spec("never")])).done;
  assert.equal(view.agents.late.status, "succeeded");
  assert.equal(view.agents.never.status, "failed");
  assert.match(view.agents.never.summary!, /without calling submit_result/);
  assert.equal(reminded, 2);
});

test("invalid submissions return an error the model can fix", async (t) => {
  const world = await fauxWorld(t, (turn) => {
    if (turn.round === 0) return submit(turn, { brief: undefined, blockers: ["x"] });
    assert.match(turn.text, /submit_result rejected: A succeeded result cannot list blockers/);
    return submit(turn);
  });
  const view = await (await world.run([spec("s")])).done;
  assert.equal(view.agents.s.status, "succeeded");
});

test("budgets with the faux provider: turns, tool calls, cost and wall clock", async (t) => {
  const loop = (_turn: FauxTurn) =>
    fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" });
  const turns = await fauxWorld(t, loop);
  let view = await (await turns.run([spec("a")], { limits: { maxTurns: 3 } })).done;
  assert.equal(view.agents.a.status, "failed");
  assert.equal(view.agents.a.reason, "turn budget exceeded");
  view = await (await turns.run([spec("b")], { limits: { maxToolCalls: 2 } })).done;
  assert.equal(view.agents.b.reason, "tool call budget exceeded");
  const costly = await fauxWorld(t, (turn) => {
    return Object.assign(loop(turn), { testCost: 0.4 });
  });
  view = await (await costly.run([spec("c")], { limits: { costUsd: 1 } })).done;
  // The agent's own budget (what was left of the run's) stops it first, as in 0.7.0.
  assert.equal(view.agents.c.status, "failed");
  assert.equal(view.agents.c.reason, "cost limit reached");
  assert.equal(view.status, "cancelled");
  assert(view.agents.c.usage.cost > 1);
  const slow = await fauxWorld(t, async (turn) => {
    await new Promise((r) => setTimeout(r, 200));
    return loop(turn);
  });
  view = await (await slow.run([spec("d")], { limits: { taskMs: 100 } })).done;
  assert.equal(view.agents.d.status, "failed");
  assert.equal(view.agents.d.reason, "deadline exceeded");
});

test("a live-checkout reader flags a checkout that changed mid-run and creates no worktree", async (t) => {
  let world!: Awaited<ReturnType<typeof fauxWorld>>;
  world = await fauxWorld(t, async (turn) => {
    // The user edits the checkout after the reader's first round (its starting fingerprint
    // is measured in the background while it starts).
    if (turn.agent === "watch" && turn.round < 2) {
      // A real first turn takes seconds: the starting fingerprint (git status, slow on
      // Windows) is measured long before the user's edit.
      if (turn.round === 1) {
        await new Promise((r) => setTimeout(r, 1500));
        await writeFile(join(world.repo, "README.md"), "# Changed by the user\n");
      }
      return fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], {
        stopReason: "toolUse",
      });
    }
    return submit(turn);
  });
  const view = await (
    await world.run([spec("watch"), spec("calm", "scout", { after: ["watch"] })])
  ).done;
  assert.equal(view.agents.watch.checkoutChanged, true);
  assert.equal(view.agents.calm.checkoutChanged, false);
  const saved = JSON.parse(
    await readFile(join(world.dir, "runs", "run-1", "results", "watch.json"), "utf8"),
  );
  assert.equal(saved.result.checkoutChanged, true);
  assert.equal(
    world.fixture.git("worktree", "list", "--porcelain").match(/^worktree /gm)!.length,
    1,
  );
  void MODEL;
  assert(!existsSync(join(world.repo, ".git", "pinata", "worktrees")));
});
