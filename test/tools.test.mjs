import test from "node:test";
import assert from "node:assert/strict";
import { executeTool, registerTools } from "../lib/tools.mjs";
import { fixture, task, settled } from "./helpers.mjs";
import { cancel } from "../lib/pinata.mjs";

const ctx = { model: { provider: "fixture", id: "fixture-model" } };
const pi = { getThinkingLevel: () => "low" };

test("typed delegation uses the shared validation and inherits the active Pi selection only when unset", async (t) => {
  const f = await fixture(t, []);
  const params = { ...f.job, config: { ...f.cfg, models: {} }, tasks: [task("one")] };
  delete params.cwd;
  const created = await executeTool("delegate", params, { ...ctx, cwd: f.cwd }, pi);
  assert.equal(created.models[0].model.thinking, "low");
  assert.equal(created.models[0].modelOrigin, "session");
  const status = await executeTool("status", { run: created.run }, ctx, pi);
  assert.equal(status.tasks[0].status, "queued"); // creation is reviewable before launch
  const explicit = await executeTool(
    "delegate",
    { ...params, config: f.cfg },
    { ...ctx, cwd: f.cwd },
    pi,
  );
  assert.equal(explicit.models[0].model.thinking, "off");
  assert.equal(explicit.models[0].modelOrigin, "job");
  await cancel(created.run);
  await cancel(explicit.run);
  await assert.rejects(
    executeTool(
      "delegate",
      { ...params, tasks: [task("bad", "builder")] },
      { ...ctx, cwd: f.cwd },
      pi,
    ),
    /Builder ownership required/,
  );
});

test("typed status/barrier validate saved evidence and invalid control parameters cannot mutate a run", async (t) => {
  const f = await fixture(t, [task("one")]);
  await settled(f);
  const status = await executeTool("status", { run: f.run, includeResults: true }, ctx, pi);
  assert.equal(status.outcomes.one.status, "succeeded");
  assert.deepEqual(await executeTool("barrier", { run: f.run, taskIds: ["one"] }, ctx, pi), {
    ready: true,
    tasks: ["one"],
  });
  await assert.rejects(
    executeTool("control", { run: f.run, action: "run-shell" }, ctx, pi),
    /Unknown control action/,
  );
  await assert.rejects(
    executeTool("control", { run: f.run, action: "cancel", confirm: true }, ctx, pi),
    /only to cleanup/,
  );
  await assert.rejects(
    executeTool("control", { run: f.run, action: "cancel", yield: true }, ctx, pi),
    /yield applies only to start/,
  );
  await assert.rejects(
    executeTool("rollback", { run: f.run, confirm: false }, ctx, pi),
    /confirm:true/,
  );
  await assert.rejects(
    executeTool("integrate", { run: f.run }, ctx, pi, { aborted: true }),
    /cancelled before execution/,
  );
  await assert.rejects(
    executeTool(
      "add",
      { run: f.run, tasks: [task("bad", "scout", {}, { after: ["missing"] })] },
      ctx,
      pi,
    ),
    /Unknown task/,
  );
  assert.deepEqual(
    (await f.manifest()).tasks.map((t) => t.spec.id),
    ["one"],
  );
});

test("worker marker prevents recursive typed tool activation and execution", async (t) => {
  const old = process.env.PINATA_WORKER;
  process.env.PINATA_WORKER = "1";
  t.after(() => {
    if (old === undefined) delete process.env.PINATA_WORKER;
    else process.env.PINATA_WORKER = old;
  });
  registerTools({ registerTool: () => assert.fail("Worker tool registered") }, {});
  await assert.rejects(
    executeTool("control", { run: "/tmp/irrelevant", action: "start" }, ctx, pi),
    /Recursive/,
  );
});

test("typed GC defaults to the current repository and rejects invalid confirmation or extra fields", async (t) => {
  const f = await fixture(t, [task("one")]);
  await settled(f);
  const report = await executeTool("gc", {}, { ...ctx, cwd: f.cwd }, pi);
  assert.equal(report.confirm, false);
  assert.equal(report.counts.runs, 1);
  assert.equal(report.counts.retained, 0);
  await assert.rejects(
    executeTool("gc", { confirm: "yes" }, { ...ctx, cwd: f.cwd }, pi),
    /Invalid GC/,
  );
  await assert.rejects(executeTool("gc", { force: true }, { ...ctx, cwd: f.cwd }, pi), /Unknown/);
});
