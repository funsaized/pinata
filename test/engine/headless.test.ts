import { copyFile, mkdir } from "node:fs/promises";
// Headless runs (M8): job files, reporters and exit codes, viewers on headless runs, and runs
// that continue in a headless host after their Pi exits. Children run the Pi devDependency's
// CLI against the loopback provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { ValidationError } from "../../engine/core/validate.ts";
import { EXIT, exitCode, jobParams } from "../../engine/headless/main.ts";
import { IpcClient } from "../../engine/ipc/client.ts";

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
  await mkdir(join(agentDir, "pinata", "agents"), { recursive: true });
  await copyFile(
    new URL("../../examples/agents/planner.md", import.meta.url),
    join(agentDir, "pinata", "agents", "planner.md"),
  );
  return { dir, repo, agentDir };
}

const reader = (agent: string | null, round: number): LoopbackReply =>
  round === 0
    ? { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] }
    : submit(agent!);

function pinata(
  args: string[],
  w: { repo: string; agentDir: string },
  env: NodeJS.ProcessEnv = {},
) {
  const child = spawn(process.execPath, [join(ROOT, "bin", "pinata.mjs"), ...args], {
    cwd: w.repo,
    env: {
      ...process.env,
      PINATA_PI: PI,
      PI_CODING_AGENT_DIR: w.agentDir,
      PINATA_NO_CONTINUE: "1",
      ...env,
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

test("job paths resolve relative to the file, mode overrides config, and outcomes map to exit codes", () => {
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

test("pinata agents lists, inspects and validates definitions through the CLI", async (t) => {
  const w = await world(t, reader);
  const listed = pinata(["agents", "list"], w);
  assert.equal(await listed.exited, 0, listed.err());
  const agents = JSON.parse(listed.out());
  assert.deepEqual(agents.map((agent: { name: string }) => agent.name).sort(), [
    "builder",
    "planner",
    "reviewer",
    "scout",
  ]);
  assert(agents.every((agent: { prompt?: string }) => agent.prompt === undefined));
  const shown = pinata(["agents", "show", "planner"], w);
  assert.equal(await shown.exited, 0, shown.err());
  assert.match(JSON.parse(shown.out()).prompt, /plan/i);
  const validated = pinata(["agents", "validate"], w);
  assert.equal(await validated.exited, 0, validated.err());
  assert.match(validated.out(), /Validated 4 agent definitions/);
  const missing = pinata(["agents", "show", "missing"], w);
  assert.equal(await missing.exited, EXIT.invalid);
  assert.match(missing.err(), /Unknown agent missing/);
});

test("pinata run executes a job headless: JSONL events, then exit 0; normal final output succeeds, an invalid job exits 2", async (t) => {
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
  assert.match(text.out(), /✓ plan \(planner\) · Done/);
  await writeFile(
    job,
    JSON.stringify({
      cwd: "repo",
      config: { models: { default: MODEL } },
      tasks: [spec("broken")],
    }),
  );
  const failed = pinata(["run", job], w);
  assert.equal(await failed.exited, EXIT.succeeded, failed.err());
  assert.match(failed.out(), /✓ broken \(scout\) · Done/);
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

test("headless shared writers and additions recover the same non-Git store", async (t) => {
  const w = await world(t, (_agent, round) =>
    round === 0
      ? {
          toolCalls: [
            { name: "write", arguments: { path: "delivered.txt", content: "shared delivery" } },
          ],
        }
      : { text: "Done without Git" },
  );
  w.repo = join(w.dir, "plain");
  await mkdir(w.repo);
  const job = join(w.dir, "plain-job.json");
  const input = {
    schemaVersion: 3,
    cwd: "plain",
    config: { models: { default: MODEL } },
    tasks: [spec("build", "builder")],
  };
  await writeFile(job, JSON.stringify(input));
  const run = pinata(["run", job, "--json"], w);
  assert.equal(await run.exited, 0, run.err());
  const events = run
    .out()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const id = events.find((event) => event.t === "run_started").run;
  assert.equal(existsSync(join(w.repo, ".git")), false);
  assert.equal(existsSync(join(w.repo, "delivered.txt")), true);
  assert.equal(existsSync(join(w.repo, ".pinata", "runs", id, "run.json")), true);
  const logs = pinata(["logs", id], w);
  assert.equal(await logs.exited, 0, logs.err());
  assert.match(logs.out(), /build.*Done/);
  await writeFile(
    job,
    JSON.stringify({
      ...input,
      run: id,
      tasks: [spec("additional", "builder", { after: ["build"] })],
    }),
  );
  const additional = pinata(["run", job, "--json"], w);
  assert.equal(await additional.exited, 0, additional.err());
  assert.match(additional.out(), /"agent":"additional"/);
  const workers = await readdir(join(w.repo, ".pinata", "runs", id, "assignments"));
  assert.deepEqual(workers.sort(), ["additional", "build"]);
  assert.equal(existsSync(join(w.repo, ".git")), false);
});
