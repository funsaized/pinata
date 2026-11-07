import { copyFile, mkdir } from "node:fs/promises";
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
import { EXIT, exitCode, jobParams, type Job } from "../../engine/headless/main.ts";
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

const writer = (agent: string | null, round: number): LoopbackReply =>
  round === 0
    ? { toolCalls: [{ name: "write", arguments: { path: "README.md", content: "delivered\n" } }] }
    : {
        toolCalls: [
          {
            name: "submit_result",
            arguments: {
              status: "succeeded",
              summary: `${agent} done`,
              changedFiles: ["README.md"],
              checks: [],
              findings: [],
              blockers: [],
            },
          },
        ],
      };

async function writerJob(w: { dir: string }, overrides: Partial<Job> = {}) {
  const job = join(w.dir, "job.json");
  await writeFile(
    job,
    JSON.stringify({
      cwd: "repo",
      approval: "Implement and apply the README change",
      config: { models: { default: MODEL }, setup: false },
      tasks: [spec("build", "builder", { ownership: ["README.md"], noChecksReason: "fixture" })],
      integratedChecks: [
        {
          id: "contents",
          argv: [
            process.execPath,
            "-e",
            "require('node:assert/strict').equal(require('node:fs').readFileSync('README.md','utf8'),'delivered\\n')",
          ],
        },
      ],
      ...overrides,
    }),
  );
  return job;
}

function records(output: string): Array<{
  t: string;
  run: string;
  status?: string;
  reason?: string;
  journal?: string;
  verification?: { application: string };
}> {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

test("headless writers deliver by default, preserve user work and report destination verification", async (t) => {
  const w = await world(t, writer);
  const definition = await readFile(new URL("../../agents/builder.md", import.meta.url), "utf8");
  await writeFile(
    join(w.agentDir, "pinata", "agents", "implementer.md"),
    definition.replace('name: "builder"', 'name: "implementer"'),
  );
  const fixture = gitRepo(w.repo);
  const head = fixture.git("rev-parse", "HEAD");
  await writeFile(join(w.repo, "user.txt"), "keep this");
  const job = await writerJob(w, {
    tasks: [
      {
        id: "build",
        agent: "implementer",
        task: "Update README",
        acceptance: ["Updated"],
        ownership: ["README.md"],
        noChecksReason: "fixture",
      },
    ],
  });
  const run = pinata(["run", job, "--json"], w);
  assert.equal(await run.exited, EXIT.succeeded, run.err() + run.out());
  const output = records(run.out());
  const result = output.at(-1)!;
  assert.equal(result.t, "integration_finished");
  assert.equal(result.status, "verified");
  assert.equal(result.verification?.application, "exact");
  assert(output.some((event) => event.t === "run_settled" && event.status === "succeeded"));
  assert.equal(await readFile(join(w.repo, "README.md"), "utf8"), "delivered\n");
  assert.equal(await readFile(join(w.repo, "user.txt"), "utf8"), "keep this");
  assert.equal(fixture.git("rev-parse", "HEAD"), head);
  assert.equal(fixture.git("diff", "--cached", "--name-only"), "");
});

test("manual delivery and --no-apply retain artifacts; integrate works without Pi and can be retried", async (t) => {
  for (const manual of [false, true]) {
    const w = await world(t, writer);
    const job = await writerJob(w, manual ? { integration: "manual" } : {});
    const run = pinata(["run", job, "--json", ...(manual ? [] : ["--no-apply"])], w);
    assert.equal(await run.exited, 0, run.err());
    const output = records(run.out());
    assert.equal(output.at(-1)!.t, "run_settled");
    assert.equal(await readFile(join(w.repo, "README.md"), "utf8"), "# Fixture\n");
    const id = output[0].run;
    const saved = JSON.parse(
      await readFile(join(w.repo, ".git", "pinata", id, "run.json"), "utf8"),
    );
    assert.equal(saved.integration, "manual");
    for (let attempt = 0; attempt < 2; attempt++) {
      const applied = pinata(["integrate", id.slice(0, 8), "--json"], w, {
        PINATA_PI: "missing-pi-executable",
      });
      assert.equal(await applied.exited, 0, applied.err() + applied.out());
      assert.equal(records(applied.out()).at(-1)!.status, "verified");
    }
    assert.equal(await readFile(join(w.repo, "README.md"), "utf8"), "delivered\n");
  }
});

test("destination failure exits nonzero after successful tasks and retains applied changes", async (t) => {
  const w = await world(t, writer);
  const job = await writerJob(w, {
    integratedChecks: [{ id: "fail", argv: [process.execPath, "-e", "process.exit(1)"] }],
  });
  const run = pinata(["run", job, "--json"], w);
  assert.equal(await run.exited, EXIT.failed, run.err());
  const output = records(run.out());
  assert(output.some((event) => event.t === "run_settled" && event.status === "succeeded"));
  assert.equal(output.at(-1)!.status, "verification_failed");
  assert.equal(await readFile(join(w.repo, "README.md"), "utf8"), "delivered\n");
});

test("automatic delivery needs checks or a reason; an explicit omission stays unverified", async (t) => {
  const w = await world(t, writer);
  const job = await writerJob(w, { integratedChecks: [] });
  const invalid = pinata(["run", job], w);
  assert.equal(await invalid.exited, EXIT.invalid);
  assert.match(invalid.err(), /integratedChecks or noIntegratedChecksReason/);
  assert(
    !existsSync(join(w.repo, ".git", "pinata")),
    "invalid delivery is rejected before preparation",
  );
  await writerJob(w, {
    integratedChecks: [],
    noIntegratedChecksReason: "Documentation-only fixture",
  });
  const run = pinata(["run", job, "--json"], w);
  assert.equal(await run.exited, 0, run.err());
  assert.equal(records(run.out()).at(-1)!.status, "applied_unverified");
});

test("automatic delivery refuses branch switches and edits made while workers run", async (t) => {
  for (const change of ["branch", "file"]) {
    let repo: string;
    const w = await world(t, async (agent, round) => {
      if (round === 0) {
        if (change === "branch") gitRepo(repo).git("checkout", "-b", "other");
        else await writeFile(join(repo, "README.md"), "user edit\n");
      }
      return writer(agent, round);
    });
    repo = w.repo;
    const run = pinata(["run", await writerJob(w), "--json"], w);
    assert.equal(await run.exited, EXIT.failed, run.err());
    const result = records(run.out()).at(-1)!;
    assert.equal(result.t, "integration_failed");
    assert.match(result.reason ?? "", change === "branch" ? /branch changed/ : /conflicts/);
    assert.equal(
      await readFile(join(repo, "README.md"), "utf8"),
      change === "branch" ? "# Fixture\n" : "user edit\n",
    );
    assert(result.journal);
    assert(!existsSync(result.journal), "preflight failure writes no journal or patches");
  }
});

test("an assigned reviewer can block automatic delivery under optional review", async (t) => {
  const w = await world(t, (agent, round) =>
    agent === "review"
      ? {
          toolCalls: [
            {
              name: "submit_result",
              arguments: {
                status: "succeeded",
                summary: "Needs work",
                changedFiles: [],
                checks: [],
                blockers: [],
                findings: [{ severity: "high", message: "Incorrect", evidence: "README.md:1" }],
                review: { verdict: "changes_requested" },
              },
            },
          ],
        }
      : writer(agent, round),
  );
  const job = await writerJob(w, {
    tasks: [
      spec("build", "builder", { ownership: ["README.md"], noChecksReason: "fixture" }),
      spec("review", "reviewer", { after: ["build"], reviewOf: "build" }),
    ],
  });
  const run = pinata(["run", job, "--json"], w);
  assert.equal(await run.exited, EXIT.failed, run.err());
  assert(!records(run.out()).some((event) => event.t === "integration_started"));
  assert.equal(await readFile(join(w.repo, "README.md"), "utf8"), "# Fixture\n");
});

test(
  "cancelling delivery stops checks and closes the journal and checkout lock",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const automatic of [true, false]) {
      const w = await world(t, writer);
      const marker = join(w.dir, "checking");
      const job = await writerJob(w, {
        integratedChecks: [
          {
            id: "wait",
            argv: [
              process.execPath,
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000)`,
            ],
          },
        ],
      });
      let run = pinata(["run", job, "--json", ...(automatic ? [] : ["--no-apply"])], w);
      if (!automatic) {
        assert.equal(await run.exited, 0, run.err());
        run = pinata(["integrate", records(run.out())[0].run, "--json"], w);
      }
      t.after(() => {
        if (run.child.exitCode === null) run.child.kill("SIGKILL");
      });
      await until(() => existsSync(marker), "destination check to start");
      run.child.kill("SIGTERM");
      assert.equal(await run.exited, EXIT.cancelled, run.err() + run.out());
      assert(!existsSync(join(w.repo, ".git", "pinata-integration.lock")));
      const result = records(run.out()).find((event) => event.t === "integration_finished");
      assert.equal(result?.status, "verification_failed");
      assert(result?.journal);
      const journal = JSON.parse(await readFile(result.journal, "utf8"));
      assert.equal(journal.status, "verification_failed");
      assert.equal(journal.verification.reason, "cancelled");
      const pid = Number(await readFile(marker, "utf8"));
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
      assert.equal(await readFile(join(w.repo, "README.md"), "utf8"), "delivered\n");
    }
  },
);

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
  assert.equal(await failed.exited, EXIT.failed, failed.err());
  assert.match(failed.out(), /✗ broken \(scout\) · Failed/);
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

test("a surviving writer graph keeps its delivery choice after Pi exits", async (t) => {
  for (const integration of [undefined, "on-success"] as const)
    await t.test(integration ?? "manual default", async (t) => {
      let release!: () => void;
      const paused = new Promise<void>((resolve) => (release = resolve));
      t.after(() => release());
      let waiting = false;
      const w = await world(t, async (agent, round) => {
        if (agent === "first" && round === 0) {
          waiting = true;
          await paused;
        }
        return agent === "second" ? writer(agent, round) : reader(agent, round);
      });
      const previous = { pi: process.env.PINATA_PI, dir: process.env.PI_CODING_AGENT_DIR };
      process.env.PINATA_PI = PI;
      // The headless host inherits this: its phases go to headless.log.
      process.env.PINATA_DEBUG = "1";
      t.after(() => void delete process.env.PINATA_DEBUG);
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
      const pi: any = {
        getSettings: () => ({}),
        getAllTools: () => [],
        getThinkingLevel: () => "off",
      };
      const host = new PinataHost(pi);
      const ctx: any = {
        cwd: w.repo,
        modelRegistry: registry,
        model: registry.find("pinata-loopback", "loopback"),
      };
      const { handle } = await host.start(
        {
          tasks: [
            spec("first"),
            spec("second", "builder", {
              after: ["first"],
              ownership: ["README.md"],
              noChecksReason: "fixture",
            }),
          ],
          approval: "Implement and deliver the fixture",
          integration,
          noIntegratedChecksReason: "fixture",
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
        // Windows: PowerShell process-identity checks take seconds each.
        process.platform === "win32" ? 180_000 : 60_000,
      ).catch(async (error) => {
        // Say why: the headless host's own log and each agent's stderr.
        const logs = [
          join(handle.dir, "headless.log"),
          join(handle.dir, "run.json"),
          join(handle.dir, "events.jsonl"),
        ];
        for (const agent of ["first", "second"])
          logs.push(
            join(handle.dir, "agents", agent, "stderr.log"),
            join(handle.dir, "agents", agent, "events.jsonl"),
            join(handle.dir, "agents", agent, "pid.json"),
          );
        const text = await Promise.all(
          logs.map(
            async (f) =>
              `--- ${f}\n${(await readFile(f, "utf8").catch(() => "(none)")).slice(-3000)}`,
          ),
        );
        throw new Error(`${(error as Error).message}\n${text.join("\n")}`);
      });
      const view = await replay(handle.dir);
      assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
      assert.equal(view.agents.second.status, "succeeded", "the dependent ran without Pi");
      const log = await readEvents(handle.dir);
      assert(log.some((e) => e.t === "run_resumed" && e.reason === "continued without Pi"));
      const owner = JSON.parse(await readFile(join(handle.dir, "run.json"), "utf8")).resume.owner;
      assert.notEqual(owner?.pid, process.pid, "the headless host owned it");
      await until(async () => !owner || !(await alive(owner)), "the headless host to exit", 15_000);
      assert.equal(record.integration, integration ?? "manual");
      assert.equal(
        await readFile(join(w.repo, "README.md"), "utf8"),
        integration === "on-success" ? "delivered\n" : "# Fixture\n",
      );
    });
});
