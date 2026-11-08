import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentResult } from "../../engine/core/types.ts";
import { fauxWorld, type FauxTurn } from "./faux.ts";
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

test("the runtime cache shares concurrent loads, replays providers and resets on disposal", async (t) => {
  const world = await fauxWorld(t, (turn) => submit(turn));
  const [first, second] = await Promise.all([
    world.cache.get(world.registry),
    world.cache.get(world.registry),
  ]);
  assert.equal(first.getModel("faux", "faux-1")?.id, "faux-1");
  assert.equal(second, first);
  assert.equal(await world.cache.get(world.registry), first);
  world.cache.dispose();
  assert.notEqual(await world.cache.get(world.registry), first);
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
  assert(!existsSync(join(world.repo, ".git", "pinata", "worktrees")));
});
