import assert from "node:assert/strict";
import test from "node:test";
import { toolRenderers, resultLines } from "../../engine/pi/render.ts";
import { ok, fail } from "../../engine/pi/tools.ts";
import type { CompactRun } from "../../engine/pi/host.ts";

const theme = { fg: (_: string, text: string) => text } as any;
function render(name: string, result: any, expanded = false, isError = false) {
  return toolRenderers(name).renderResult!(result, { expanded, isPartial: false }, theme, {
    args: {},
    isError,
  } as any)
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
}

test("tool renderers keep errors visible, handle streaming arguments, and preserve transcript lines", () => {
  assert.match(
    render("run", fail(new Error("Unknown agent missing"))),
    /Error: Unknown agent missing/,
  );
  assert.match(
    render("run", { content: [{ type: "text", text: "Tool execution interrupted" }] }, false, true),
    /Tool execution interrupted/,
  );
  const call = toolRenderers("run").renderCall!({ tasks: [null, { id: "scout" }] }, theme, {
    expanded: false,
  } as any);
  assert.match(call.render(80).join("\n"), /scout \(agent\)/);
  const steer = toolRenderers("steer").renderCall!(
    { run: "12345678", task: "scout", message: "Read the tests too" },
    theme,
    { expanded: true } as any,
  );
  assert.match(steer.render(100).join("\n"), /"message": "Read the tests too"/);
  const transcript = render(
    "status",
    ok({ run: "12345678", task: "scout", excerpt: "user: Find it\nassistant: Found it" }),
  );
  assert.match(transcript, /user: Find it\nassistant: Found it/);
  assert.match(transcript, /\/pinata view 12345678 --task scout/);
});

test("summaries show engine failures and checkout verification limitations without expansion", () => {
  const task = render(
    "status",
    ok({
      task: "builder",
      status: "failed",
      reason: "Evidence check failed",
      result: { status: "succeeded", summary: "Looks good" },
    }),
  );
  assert.match(task, /builder · Failed — Evidence check failed/);
  assert(!task.includes("Done"), "an agent's own success claim cannot override the engine outcome");
  const verification = {
    status: "verification_failed",
    application: "different",
    freshness: "historical",
    checks: [{ id: "test", passed: false, reason: "Exit 1" }],
  };
  const result = render("verify", ok(verification));
  assert.match(result, /Checks failed/);
  assert.match(result, /test — Exit 1/);
  assert.match(result, /Checkout differs from the reviewed/);
  assert.match(result, /Verification is historical/);
  assert.match(render("verify", ok(verification), true), /"application": "different"/);
});

test("completion summaries can expand and identify which page of agents is shown", () => {
  const run: CompactRun = {
    run: "12345678-abcd",
    dir: "/run",
    status: "failed",
    costUsd: 0.01,
    tokens: 5000,
    elapsedMs: 10_000,
    taskCount: 12,
    taskOffset: 4,
    nextOffset: 11,
    tasks: Array.from({ length: 7 }, (_, i) => ({
      id: `agent-${i + 5}`,
      role: "scout",
      status: "succeeded",
      summary: "Done",
    })),
    counts: { succeeded: 11, failed: 1 },
    more: "More results",
  };
  const compact = resultLines(run).join("\n");
  assert.match(compact, /1 failed/);
  assert.match(compact, /Showing agents 5–10 of 12/);
  assert(!compact.includes("agent-11"));
  const expanded = resultLines(run, true).join("\n");
  assert.match(expanded, /agent-11/);
  assert.match(expanded, /Showing agents 5–11 of 12/);
});
