// Headless runs (M8): job files, reporters and exit codes, viewers on headless runs, and runs
// that continue in a headless host after their Pi exits. Children run the Pi devDependency's
// CLI against the loopback provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { alive } from "../../engine/backends/supervise.ts";
import { readEvents, replay } from "../../engine/core/store.ts";
import { ValidationError } from "../../engine/core/validate.ts";
import { EXIT, exitCode, jobParams } from "../../engine/headless/main.ts";
import { IpcClient } from "../../engine/ipc/client.ts";
import { PinataHost } from "../../engine/pi/host.ts";
import { startLoopback, type LoopbackReply } from "../../bench/providers/loopback.ts";
import { gitRepo } from "./faux.ts";
import { spec, tempDir } from "./helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "cli.js",
);
const PI = process.env.PINATA_PI ?? CLI;
const MODEL = { provider: "pinata-loopback", id: "loopback", thinking: "off" };

const submit = (agent: string): LoopbackReply => ({
  toolCalls: [
    {
      name: "submit_result",
      arguments: {
        status: "succeeded",
        summary: `${agent} done`,
        changedFiles: [],
        checks: [],
        findings: [],
        blockers: [],
        brief: `${agent} brief`,
      },
    },
  ],
});

// A repository, an agent dir whose models.json reaches a loopback server, and the server.
async function world(
  t: TestContext,
  respond: (agent: string | null, round: number) => LoopbackReply | Promise<LoopbackReply>,
) {
  const dir = await tempDir(t, "pinata-headless-");
  const repo = join(dir, "repo");
  await gitRepo(repo).init();
  const agentDir = join(dir, "agent");
  const loopback = await startLoopback({
    tokenDelayMs: 0,
    responder: ({ text, body }) => {
      const agent = /# Task ([a-z][a-z0-9-]*) \(/.exec(text)?.[1] ?? null;
      const round = (body.messages ?? []).filter((m: any) => m.role === "assistant").length;
      return respond(agent, round);
    },
  });
  t.after(() => loopback.close());
  await loopback.writeModels(agentDir);
  return { dir, repo, agentDir };
}

const reader = (agent: string | null, round: number): LoopbackReply =>
  round === 0
    ? { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] }
    : submit(agent!);

function pinata(args: string[], w: { repo: string; agentDir: string }) {
  const child = spawn(process.execPath, [join(ROOT, "bin", "pinata.mjs"), ...args], {
    cwd: w.repo,
    env: {
      ...process.env,
      PINATA_PI: PI,
      PI_CODING_AGENT_DIR: w.agentDir,
      PINATA_NO_CONTINUE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
  return { child, exited, out: () => stdout, err: () => stderr };
}

async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("job files keep 0.7.0's shape; exit codes map run outcomes", () => {
  const params = jobParams(
    { cwd: "../repo", approval: "ok", config: { mode: "lean" }, tasks: [spec("scout")] },
    "/work/jobs/job.json",
    "observe",
  );
  assert.equal(params.cwd, resolve("/work/repo"));
  assert.equal(params.config!.mode, "observe", "--mode overrides the job's config");
  assert.throws(
    () => jobParams({ allowWrites: false, tasks: [spec("b", "builder")] }, "/j.json"),
    (e: Error) => e instanceof ValidationError && /allowWrites is false/.test(e.message),
  );
  assert.throws(() => jobParams({} as never, "/j.json"), /tasks array/);
  const view = (status: string) => ({ status }) as never;
  assert.equal(exitCode(view("succeeded")), EXIT.succeeded);
  assert.equal(exitCode(view("failed")), EXIT.failed);
  assert.equal(exitCode(view("cancelled")), EXIT.cancelled);
});

test("pinata run executes a job headless: JSONL events, then exit 0; a failure exits 1, an invalid job 2", async (t) => {
  const w = await world(t, (agent, round) =>
    agent === "broken" ? { text: "I will not submit." } : reader(agent, round),
  );
  const job = join(w.dir, "job.json");
  await writeFile(
    job,
    JSON.stringify({
      cwd: "repo",
      config: { models: { default: MODEL } },
      tasks: [spec("map"), spec("plan", "planner", { after: ["map"] })],
    }),
  );
  const run = pinata(["run", job, "--json"], w);
  assert.equal(await run.exited, 0, run.err());
  const events = run
    .out()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
  assert.equal(events[0].t, "run_started");
  assert.deepEqual(
    events.filter((e) => e.t === "agent_settled").map((e) => [e.agent, e.status]),
    [
      ["map", "succeeded"],
      ["plan", "succeeded"],
    ],
  );
  assert.equal(events.at(-1).t, "run_settled");
  const text = pinata(["logs", events[0].run.slice(0, 8)], w);
  assert.equal(await text.exited, 0, text.err());
  assert.match(text.out(), /✓ planner plan succeeded/);
  await writeFile(
    job,
    JSON.stringify({
      cwd: "repo",
      config: { models: { default: MODEL } },
      tasks: [spec("broken")],
    }),
  );
  const failed = pinata(["run", job], w);
  assert.equal(await failed.exited, EXIT.failed, failed.err());
  assert.match(failed.out(), /✗ scout broken failed/);
  await writeFile(job, JSON.stringify({ cwd: "repo", tasks: [{ id: "Bad id", role: "scout" }] }));
  const bad = pinata(["run", job], w);
  assert.equal(await bad.exited, EXIT.invalid);
  assert.match(bad.err(), /pinata: /);
});

test("pinata run --watch lets a viewer attach to the headless run", async (t) => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const w = await world(t, async (agent, round) => {
    if (round === 0) await paused;
    return reader(agent, round);
  });
  const job = join(w.dir, "job.json");
  await writeFile(
    job,
    JSON.stringify({ cwd: "repo", config: { models: { default: MODEL } }, tasks: [spec("look")] }),
  );
  const run = pinata(["run", job, "--watch"], w);
  const runs = join(w.repo, ".git", "pinata");
  let dir = "";
  await until(async () => {
    const names = existsSync(runs) ? await readdir(runs) : [];
    dir = names.map((n) => join(runs, n)).find((d) => existsSync(join(d, "link.json"))) ?? "";
    return !!dir;
  }, "the headless run's socket");
  const viewer = await IpcClient.connect(dir);
  assert.equal(viewer.view?.agents.look.status, "running");
  release();
  assert.equal(await run.exited, 0, run.err());
  await until(
    () => viewer.closed || viewer.view?.status === "succeeded",
    "the viewer to see the end",
  );
  viewer.close();
  assert.match(run.err(), /pinata view [0-9a-f]{8}/);
});

test("a surviving graph with dependents finishes in a headless host after its Pi exits", async (t) => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  let waiting = false;
  const w = await world(t, async (agent, round) => {
    if (agent === "first" && round === 0) {
      waiting = true;
      await paused;
    }
    return reader(agent, round);
  });
  const previous = { pi: process.env.PINATA_PI, dir: process.env.PI_CODING_AGENT_DIR };
  process.env.PINATA_PI = PI;
  process.env.PI_CODING_AGENT_DIR = w.agentDir;
  t.after(() => {
    if (previous.pi === undefined) delete process.env.PINATA_PI;
    else process.env.PINATA_PI = previous.pi;
    if (previous.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.dir;
  });
  const runtime = await ModelRuntime.create({
    authPath: join(w.agentDir, "auth.json"),
    modelsPath: join(w.agentDir, "models.json"),
  });
  const registry = new ModelRegistry(runtime);
  await registry.refresh({ allowNetwork: false });
  const pi: any = { getSettings: () => ({}), getAllTools: () => [], getThinkingLevel: () => "off" };
  const host = new PinataHost(pi);
  const ctx: any = {
    cwd: w.repo,
    modelRegistry: registry,
    model: registry.find("pinata-loopback", "loopback"),
  };
  const { handle } = await host.start(
    {
      tasks: [spec("first"), spec("second", "planner", { after: ["first"] })],
      background: true,
      survive: true,
      config: { models: { default: MODEL } },
    },
    ctx,
  );
  await until(() => waiting, "the first agent's request");
  // Pi exits: the run is released and continued by a detached headless host.
  await host.shutdown("parent exit");
  const record = JSON.parse(await readFile(join(handle.dir, "run.json"), "utf8"));
  release();
  await until(
    async () => (await readEvents(handle.dir)).some((e) => e.t === "run_settled"),
    "the headless host to finish the run",
    60_000,
  );
  const view = await replay(handle.dir);
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  assert.equal(view.agents.second.status, "succeeded", "the dependent ran without Pi");
  const log = await readEvents(handle.dir);
  assert(log.some((e) => e.t === "run_resumed" && e.reason === "continued without Pi"));
  const owner = JSON.parse(await readFile(join(handle.dir, "run.json"), "utf8")).resume.owner;
  assert.notEqual(owner?.pid, process.pid, "the headless host owned it");
  await until(async () => !owner || !(await alive(owner)), "the headless host to exit", 15_000);
  void record;
});
