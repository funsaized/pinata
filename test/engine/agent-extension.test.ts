import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { guard, allowedTools } from "../../engine/agent/extension.ts";
import { fauxWorld, type FauxTurn } from "./faux.ts";
import { spec } from "./helpers.ts";

const call = (name: string, args: Record<string, any>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const submit = (changedFiles: string[] = [], brief?: string) =>
  call("submit_result", {
    status: "succeeded",
    summary: "done",
    changedFiles,
    checks: [],
    findings: [],
    blockers: [],
    ...(brief && { brief }),
  });

function toolResults(turn: FauxTurn): string[] {
  return turn.context.messages
    .filter((m: any) => m.role === "toolResult")
    .map((m: any) => (m.content ?? []).map((c: any) => c.text ?? "").join(""));
}

test("blocked builder writes return an error to the model and never touch disk", async (t) => {
  const seen: string[] = [];
  const world = await fauxWorld(t, (turn) => {
    const steps = [
      () => call("write", { path: "b.txt", content: "unowned" }),
      () => call("write", { path: "../outside.txt", content: "escape" }),
      () => call("edit", { path: ".git/config", edits: [{ oldText: "a", newText: "b" }] }),
      () => call("write", { path: "a.txt", content: "owned" }),
      () => submit(["a.txt"]),
    ];
    seen.push(...toolResults(turn).slice(-1));
    return steps[turn.round]();
  });
  const view = await (
    await world.run(
      [spec("build", "builder", { ownership: ["a.txt"], noChecksReason: "fixture" })],
      { allowWrites: true },
    )
  ).done;
  assert.equal(view.agents.build.status, "succeeded", JSON.stringify(view.agents.build));
  assert.match(seen[0], /b\.txt is outside this builder's ownership \(a\.txt\)/);
  assert.match(seen[1], /outside the workspace/);
  assert.match(seen[2], /not a safe repository path/);
  assert(!existsSync(join(world.repo, "b.txt")));
  assert(!existsSync(join(world.dir, "outside.txt")));
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "owned");
});

test("codemode scripts cannot bypass the guard", async (t) => {
  const seen: string[] = [];
  const world = await fauxWorld(t, (turn) => {
    seen.push(...toolResults(turn).slice(-1));
    if (turn.agent === "build" && turn.round === 0)
      return call("codemode", {
        code: 'try { await tools.write({ path: "b.txt", content: "x" }); text("wrote"); } catch (e) { text("blocked: " + e.message); }',
      });
    if (turn.agent === "look" && turn.round === 0)
      return call("codemode", {
        code: 'try { await tools.bash({ command: "echo hi > c.txt" }); text("ran"); } catch (e) { text("blocked: " + e.message); }',
      });
    return turn.agent === "look" ? submit([], "map") : submit();
  });
  const view = await (
    await world.run(
      [
        spec("build", "builder", { ownership: ["a.txt"], noChecksReason: "fixture" }),
        spec("look", "scout"),
      ],
      { allowWrites: true, data: { codemode: true } },
    )
  ).done;
  assert.equal(view.agents.build.status, "succeeded", JSON.stringify(view.agents.build));
  assert.equal(view.agents.look.status, "succeeded", JSON.stringify(view.agents.look));
  const joined = seen.join("\n");
  assert.match(joined, /blocked: .*b\.txt is outside this builder's ownership/);
  assert.match(joined, /blocked: .*bash is not available to the scout role|blocked: .*bash/);
  assert(!existsSync(join(world.repo, "b.txt")));
  assert(!existsSync(join(world.repo, "c.txt")));
});

test("the guard: loadout, read-only roles and ownership", () => {
  const scout = {
    run: "r",
    task: "s",
    role: "scout" as const,
    tools: ["read", "grep", "find", "ls"],
    ownership: [],
    readOnly: true,
  };
  const allowed = allowedTools({ ...scout, codemode: true });
  assert.equal(guard(scout, allowed, "read", { path: "x" }, "/repo"), null);
  assert.equal(guard(scout, allowed, "codemode", {}, "/repo"), null);
  assert.equal(guard(scout, allowed, "submit_result", {}, "/repo"), null);
  assert.match(
    guard(scout, allowed, "bash", { command: "ls" }, "/repo")!,
    /bash is not available to the scout role/,
  );
  const sneaky = new Set([...allowed, "write"]);
  assert.match(guard(scout, sneaky, "write", { path: "x" }, "/repo")!, /read-only/);
});
