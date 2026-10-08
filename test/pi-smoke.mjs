import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { ROOT, ROLES, command, atomic, readJson, rpcProbe, sleep, living } from "../lib/core.mjs";
import { init, wait, cleanup, cancel } from "../lib/pinata.mjs";
import { repository, task } from "./helpers.mjs";

// Only a localhost OpenAI-compatible fixture is contacted. No live credentials.
const repo = await repository("pinata-pi-smoke-");
const agent = path.join(repo.dir, "agent"),
  home = path.join(repo.dir, "home");
await fs.mkdir(agent);
await fs.mkdir(home);
const originalEnv = { ...process.env };
const webExtension = process.env.PINATA_TEST_WEB_EXTENSION;
const env = {
  PATH: process.env.PATH,
  HOME: home,
  LANG: "C",
  LC_ALL: "C",
  PI_CODING_AGENT_DIR: agent,
  // The package's extension is the engine; this 0.7.0 smoke loads 0.7.0's instead.
  PINATA_LEGACY: "1",
  PI_OFFLINE: "1",
  npm_config_cache: path.join(repo.dir, "npm-cache"),
  npm_config_userconfig: path.join(repo.dir, "npmrc"),
  TEST_HERDR_STATE: path.join(repo.dir, "herdr.json"),
};
const requests = [],
  rounds = new Map(),
  fixtureErrors = [];
let activeRun,
  typedRun,
  sourceFetches = 0;
let origin;
async function typedUntil(predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const run = await readJson(path.join(typedRun, "manifest.json"));
    if (await predicate(run)) return run;
    await sleep(50);
  }
  throw new Error("Typed Pi orchestration did not reach the expected state");
}
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET") {
      sourceFetches++;
      res.writeHead(req.url === "/source" ? 200 : 404, { "content-type": "text/html" });
      res.end(
        "<html><head><title>Local source</title></head><body><article><h1>Fixture authoritative source</h1>" +
          Array.from(
            { length: 12 },
            (_, i) =>
              `<p>Evidence section ${i + 1}. This loopback source validates direct HTTP extraction and stored content. The fixture carries no production claim or external credentials. Readable extraction needs enough article text to distinguish a real document from a partial page or error response.</p>`,
          ).join("") +
          "</article></body></html>",
      );
      return;
    }
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    requests.push(body);
    const text = body.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    const match = text.match(/"attemptDir": ?("(?:[^"\\]|\\.)*")/);
    const spec = match ? await readJson(path.join(JSON.parse(match[1]), "task.json")) : null;
    if (spec?.task.task === "force-provider-error") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Local fixture provider error", type: "invalid_request_error" },
        }),
      );
      return;
    }
    let content = "Loopback acknowledgement",
      call;
    if (!spec && text.includes("typed-tool-probe")) {
      const phase = rounds.get("typed-tool-probe") ?? 0;
      rounds.set("typed-tool-probe", phase + 1);
      const names = (body.tools ?? []).map((x) => x.function.name);
      assert(
        names.includes("pinata_delegate") &&
          names.includes("pinata_repair") &&
          names.includes("pinata_integrate"),
      );
      if (phase === 0) call = ["pinata_delegate", { approval: 123, tasks: [] }];
      if (phase === 1)
        call = [
          "pinata_delegate",
          {
            approval: "Localhost-only typed tools smoke",
            config: {
              herdr: path.join(ROOT, "test/fixtures/herdr.mjs"),
              session: "fixture",
              passEnv: ["TEST_HERDR_STATE"],
              limits: { startupMs: 5000, taskMs: 30_000, jobMs: 120_000, maxToolCalls: 1 },
            },
            tasks: [task("typed"), { ...task("budget"), task: "force-tool-budget" }],
          },
        ];
      if (phase === 2) {
        const message = body.messages.findLast((m) => m.role === "tool");
        const result = JSON.parse(message.content);
        typedRun = result.run;
        assert(typedRun);
        assert.equal(result.models[0].model.id, "loopback");
        assert.equal(result.models[0].modelOrigin, "session");
        call = ["pinata_status", { run: typedRun }];
      }
      if (phase === 3) {
        const result = JSON.parse(body.messages.findLast((m) => m.role === "tool").content);
        assert.equal(result.tasks[0].status, "queued");
        call = ["pinata_control", { run: typedRun, action: "start" }];
      }
      if (phase === 4) {
        await typedUntil(
          async (run) =>
            run.background?.notification?.status === "delivered" &&
            !(await living([run.background.runner])).length,
        );
        call = ["pinata_status", { run: typedRun, includeResults: true }];
      }
      if (phase === 5) {
        const result = JSON.parse(body.messages.findLast((m) => m.role === "tool").content);
        assert.equal(result.tasks[0].status, "succeeded");
        assert.equal(result.outcomes.typed.actualModel.id, "loopback");
        assert.equal(result.tasks[1].status, "failed");
        assert.match(result.tasks[1].error, /tool call budget exceeded/);
        call = [
          "pinata_add",
          { run: typedRun, tasks: [{ ...task("cancel-active"), task: "force-hang" }] },
        ];
      }
      if (phase === 6) call = ["pinata_control", { run: typedRun, action: "resume" }];
      if (phase === 7) {
        const result = JSON.parse(body.messages.findLast((m) => m.role === "tool").content);
        assert.equal(result.tasks?.at(-1).status, "launching", JSON.stringify(result));
        await typedUntil(async (run) => {
          const file = path.join(run.dir, "tasks/cancel-active/1/process.json");
          const process = await readJson(file).catch(() => null);
          return process?.children?.length && (await living(process.children)).length;
        });
        call = ["pinata_control", { run: typedRun, action: "cancel" }];
      }
      if (phase === 8) {
        const result = JSON.parse(body.messages.findLast((m) => m.role === "tool").content);
        assert(result.cancelled);
        assert.equal(result.tasks.at(-1).status, "cancelled");
        assert.equal(result.tasks.at(-1).paneClosed, true);
        call = ["pinata_gc", { cwd: repo.cwd }];
      }
      if (phase === 9) {
        const result = JSON.parse(body.messages.findLast((m) => m.role === "tool").content);
        assert.equal(result.confirm, false);
        assert.equal(result.counts.runs, 1);
        assert.equal(result.counts.retained, 0);
      }
    }
    if (spec) {
      const result = {
        schemaVersion: 1,
        runId: spec.runId,
        taskId: spec.task.id,
        attemptId: spec.attemptId,
        taskDigest: spec.taskDigest,
        status: "succeeded",
        summary: "Local fixture evidence only",
        changedFiles: [],
        commit: null,
        checks: [],
        findings: [],
        blockers: [],
        brief:
          "Fixture authoritative source fetched. Missing credentials, denied providers, and failed direct fetches are surfaced rather than silently routed elsewhere.",
      };
      if (spec.task.role === "research") {
        const phase = rounds.get(spec.attemptId) ?? 0;
        rounds.set(spec.attemptId, phase + 1);
        const tools = (body.tools ?? []).map((x) => x.function.name);
        if (phase === 0) {
          assert(tools.includes("web_enable"));
          assert(!tools.includes("web_search"));
          call = ["web_enable", {}];
        }
        if (phase === 1) {
          assert(tools.includes("web_search") && tools.includes("fetch_content"));
          call = ["web_search", { query: "local test missing key", workflow: "none" }];
        }
        if (phase === 2)
          call = [
            "web_search",
            { query: "local test denied route", provider: "openai", workflow: "none" },
          ];
        if (phase === 3) call = ["fetch_content", { url: origin + "/source", mode: "readable" }];
        if (phase === 4) call = ["fetch_content", { url: origin + "/missing", mode: "readable" }];
        if (phase === 5) {
          const stored = body.messages
            .filter((m) => m.role === "tool")
            .map((m) => m.content)
            .join("\n")
            .match(/responseId "([^"]+)"/);
          assert(stored, "Search response did not supply a stored-result ID");
          call = ["get_search_content", { responseId: stored[1], queryIndex: 0 }];
        }
        result.sources = [
          {
            url: origin + "/source",
            title: "Local source",
            supports: "Fixture source content",
            applicability: "Loopback test only",
          },
        ];
      }
      content = JSON.stringify(result);
      if (spec.task.task === "force-tool-budget") call = ["read", { path: "a.txt" }];
      if (spec.task.task === "force-hang") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": waiting for cancellation\n\n");
        return;
      }
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk", created: 1, model: "loopback", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (call) {
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${requests.length}`,
            type: "function",
            function: { name: call[0], arguments: JSON.stringify(call[1]) },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content });
      emit({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (e) {
    fixtureErrors.push(e.stack);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.message } }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
origin = `http://127.0.0.1:${server.address().port}`;
async function run(argv, options = {}) {
  const r = await command(argv, { cwd: repo.cwd, env, timeoutMs: 60_000, ...options });
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return r;
}
try {
  await atomic(path.join(agent, "settings.json"), {
    retry: { enabled: false },
    quietStartup: true,
  });
  await atomic(path.join(agent, "models.json"), {
    providers: {
      "pinata-loopback": {
        baseUrl: origin + "/v1",
        api: "openai-completions",
        apiKey: "fixture-not-a-real-secret",
        models: [
          {
            id: "loopback",
            name: "Local test fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 65536,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  });
  const packed = JSON.parse(
    (
      await run(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", repo.dir], {
        cwd: ROOT,
      })
    ).stdout,
  )[0];
  const paths = packed.files.map((x) => x.path);
  assert.equal(paths.filter((p) => p.startsWith("skills/") && p.endsWith("/SKILL.md")).length, 2);
  assert.equal(paths.filter((p) => p.startsWith("prompts/")).length, 7);
  assert(
    !paths.some((p) => /^(test|node_modules|\.git)\/|PLAN\.md|\.log$|\.env/.test(p)),
    "Development or sensitive files in tarball",
  );
  const prefix = path.join(repo.dir, "prefix");
  await run([
    "npm",
    "install",
    "--prefix",
    prefix,
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    path.join(repo.dir, packed.filename),
  ]);
  const installed = path.join(prefix, "node_modules/pi-pinata");
  await run(["pi", "install", installed, "--no-approve"]);
  const worktree = path.join(repo.dir, "unrelated-worktree");
  await run(["git", "-C", repo.cwd, "worktree", "add", "--detach", worktree]);
  for (const cwd of [repo.cwd, worktree]) {
    const resolved = JSON.parse(
      (await run([process.execPath, path.join(installed, "lib/pinata.mjs"), "resources", cwd]))
        .stdout,
    );
    assert(resolved.ok, JSON.stringify(resolved));
    assert.equal(resolved.mappings.length, 9);
    const rpc = await rpcProbe(
      "pi",
      cwd,
      env,
      [{ id: "commands", type: "get_commands" }],
      [],
      true,
    );
    const commands = rpc
      .get("commands")
      .commands.filter((c) => c.sourceInfo?.path?.startsWith(installed));
    assert.equal(commands.length, 9);
    assert(
      commands.every((c) => c.sourceInfo.scope === "user" && c.sourceInfo.origin === "package"),
    );
  }
  const base = [
    "pi",
    "--mode",
    "json",
    "--offline",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--no-themes",
    "--no-approve",
    "--tools",
    "read",
    "--provider",
    "pinata-loopback",
    "--model",
    "loopback",
    "--thinking",
    "off",
  ];
  await run([...base, "--", "Activation test, acknowledge only."]);
  const system = requests
    .at(-1)
    .messages.filter((m) => ["system", "developer"].includes(m.role))
    .map((m) => m.content)
    .join("\n");
  assert(system.includes("<name>subagents</name>"), system.slice(-6000));
  assert(!system.includes("<name>engmgmt</name>"));
  const typedBase = base.filter(
    (x, i) => x !== "--no-extensions" && x !== "--tools" && base[i - 1] !== "--tools",
  );
  await run([...typedBase, "--", "typed-tool-probe"]);
  assert.deepEqual(fixtureErrors, []);
  const typedTranscript = requests
    .findLast((r) => JSON.stringify(r.messages).includes("typed-tool-probe"))
    .messages.filter((m) => m.role === "tool")
    .map((m) => m.content)
    .join("\n");
  assert.match(typedTranscript, /approval/);
  assert(typedRun);
  assert.equal(rounds.get("typed-tool-probe"), 10);
  const typedManifest = await readJson(path.join(typedRun, "manifest.json"));
  assert.equal(typedManifest.cancelled, true);
  assert.equal(typedManifest.versions.node, process.version);
  assert.equal(await fs.realpath(typedManifest.runtime.node), await fs.realpath(process.execPath));
  assert(typedManifest.tasks.every((task) => task.attempts[0].closed));
  assert.equal(typedManifest.background.notification.status, "delivered");
  assert(
    (await readJson(path.join(repo.dir, "herdr.json"))).notifications[0].text.includes(
      typedManifest.runtime.node,
    ),
  );
  for (const task of typedManifest.tasks) {
    const attempt = path.join(typedRun, "tasks", task.spec.id, "1");
    const processes = await readJson(path.join(attempt, "process.json"));
    assert.equal((await living([processes.runner, ...processes.children])).length, 0);
    assert(await readJson(path.join(attempt, "claim.json")));
    assert(await readJson(path.join(attempt, "outcome.json")));
  }
  console.log(
    "PASS packed typed tools: start, completion, budgets, notification, resume and active cancellation from Pi's runtime",
  );
  await run([...base, "--", "/skill:engmgmt Activation test, acknowledge only."]);
  assert(JSON.stringify(requests.at(-1).messages).includes("../subagents/SKILL.md"));
  for (const role of ROLES) {
    await run([...base, "--", `/${role} LOCAL ARGUMENT`]);
    const text = JSON.stringify(requests.at(-1).messages);
    assert(
      text.includes("LOCAL ARGUMENT") &&
        text.includes(
          `pinata's ${role === "reviewer" ? "independent adversarial reviewer" : role}`,
        ),
    );
  }
  await fs.mkdir(path.join(agent, "prompts"), { recursive: true });
  const collision = path.join(agent, "prompts/reviewer.md");
  await fs.writeFile(collision, "USER TEMPLATE MUST REMAIN\n");
  const conflict = await command(
    [process.execPath, path.join(installed, "lib/pinata.mjs"), "resources", repo.cwd],
    { env },
  );
  assert.equal(conflict.code, 1);
  assert.equal(await fs.readFile(collision, "utf8"), "USER TEMPLATE MUST REMAIN\n");
  await run([
    ...base,
    "--no-skills",
    "--no-prompt-templates",
    "--prompt-template",
    path.join(installed, "prompts/reviewer.md"),
    "--",
    "/reviewer",
  ]);
  assert(
    JSON.stringify(requests.at(-1).messages).includes("pinata's independent adversarial reviewer"),
  );
  assert(!JSON.stringify(requests.at(-1).messages).includes("USER TEMPLATE MUST REMAIN"));
  console.log(
    "PASS packed global resource activation, explicit-only engmgmt, seven templates, unrelated worktree, collision preservation, and explicit child template",
  );

  // Run the real installed Pi behind a mocked Herdr transport, with captured
  // coordinator environment rather than any credentials inherited by the server.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.env.TEST_HERDR_STATE = path.join(repo.dir, "herdr.json");
  const cfg = {
    pi: "pi",
    herdr: path.join(ROOT, "test/fixtures/herdr.mjs"),
    session: "fixture",
    models: { default: { provider: "pinata-loopback", id: "loopback", thinking: "off" } },
    passEnv: ["TEST_HERDR_STATE"],
    limits: { taskMs: 30_000, jobMs: 120_000 },
  };
  if (webExtension) {
    cfg.webExtension = webExtension;
    const policy = await readJson(path.join(ROOT, "examples/web-search.json"));
    await atomic(path.join(agent, "web-search.json"), {
      ...policy,
      ssrf: { allowRanges: ["127.0.0.1/32"] },
    });
  }
  const tasks = [
    task("good"),
    { ...task("bad"), task: "force-provider-error" },
    ...(webExtension ? [task("research", "research")] : []),
  ];
  activeRun = (
    await init({
      cwd: repo.cwd,
      approval: "Localhost-only fixture, no live providers",
      config: cfg,
      tasks,
    })
  ).run;
  const status = await wait(activeRun, 90_000);
  assert.equal(status.tasks[0].status, "succeeded", JSON.stringify(status));
  assert.equal(status.tasks[1].status, "failed", JSON.stringify(status));
  const bad = await readJson(path.join(activeRun, "tasks/bad/1/outcome.json"));
  assert.equal(bad.process.code, 0);
  assert.equal(bad.finalStopReason, "error");
  assert(!(await fs.readdir(path.join(activeRun, "tasks/good/1"))).includes("environment.json"));
  if (webExtension) {
    assert.equal(status.tasks[2].status, "succeeded", JSON.stringify(status));
    assert(sourceFetches >= 2);
    const research = requests.filter((r) => JSON.stringify(r.messages).includes("research-1"));
    const transcript = research
      .at(-1)
      .messages.filter((m) => m.role === "tool")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    assert.match(transcript, /Fixture authoritative source/);
    assert.match(transcript, /allowed|disallowed|not permitted|disabled/i);
    assert.match(transcript, /API.key|apiKey|authentication|credential/i);
    assert.match(transcript, /404/);
    console.log(
      "PASS real pi-web-access dynamic activation, missing-key/denied-route failures, direct source fetch, failed fetch without fallback, sourced artifact",
    );
  } else
    console.log(
      "SKIP real pi-web-access: set PINATA_TEST_WEB_EXTENSION to its installed entry file",
    );
  console.log("PASS real Pi supervised JSON success and assistant-error-with-exit-zero rejection");
  await cleanup(activeRun, true);
  await run(["pi", "remove", installed, "--no-approve"]);
  await run([...typedBase, "--", "Package removal tool probe"]);
  assert(!requests.at(-1).tools.some((x) => x.function.name.startsWith("pinata_")));
  const remaining = await rpcProbe(
    "pi",
    repo.cwd,
    env,
    [{ id: "commands", type: "get_commands" }],
    [],
    true,
  );
  assert(
    !remaining.get("commands").commands.some((c) => c.sourceInfo?.path?.startsWith(installed)),
  );
  console.log("PASS isolated package removal; no personal Pi configuration changed");
} finally {
  if (typedRun) await cancel(typedRun);
  if (activeRun) await cancel(activeRun);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(repo.dir, { recursive: true, force: true });
}
