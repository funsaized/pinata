import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { surfaceReplySchema } from "../../engine/contracts/index.ts";
import { parseArguments } from "../../engine/headless/arguments.ts";
import { openHost as openProductionHost } from "../../engine/host/index.ts";
import { openHost } from "./fixtures/rewrite-cli-factory.ts";

const cli = fileURLToPath(new URL("../../bin/pinata.mjs", import.meta.url));
const execute = promisify(execFile);

async function invoke(args: string[]) {
  let code = 0;
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execute(process.execPath, [cli, ...args, "--json"], {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("stdout" in error) ||
      !("stderr" in error) ||
      !("code" in error) ||
      typeof error.code !== "number"
    )
      throw error;
    code = error.code;
    stdout = String(error.stdout);
    stderr = String(error.stderr);
  }
  const values: unknown[] = stdout.trim()
    ? stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { code, stdout, stderr, values };
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-headless-")));
  const workspace = join(directory, "workspace");
  const definitions = join(directory, "definitions");
  const agentDir = join(directory, "agent");
  await Promise.all([mkdir(workspace), mkdir(definitions), mkdir(agentDir)]);
  await writeFile(
    join(definitions, "fixture.md"),
    "---\nschemaVersion: 1\nname: fixture\nhandoffDescription: Scripted host fixture\ntools: [read]\n---\nRead the scripted assignment.\n",
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, workspace, definitions, agentDir };
}

test("CLI discovers schemas, tools and definitions without opening a host", async (t) => {
  const world = await fixture(t);
  assert.throws(() => parseArguments(["schema", "--json", "--json"]), /only once/);
  assert.throws(() => parseArguments(["schema", "--unknown"]), /Unknown option/);
  const schemas = await invoke(["schema", "pinata.command.v2"]);
  assert.equal(schemas.code, 0, schemas.stderr);
  assert.match(schemas.stdout, /requestId/);
  const tools = await invoke(["tools"]);
  assert.equal(tools.code, 0, tools.stderr);
  assert.match(tools.stdout, /pinata_steer/);
  assert.doesNotMatch(tools.stdout, /pinata_schedule/);
  const agents = await invoke(["agents", "show", "fixture", "--definitions", world.definitions]);
  assert.equal(agents.code, 0, agents.stderr);
  assert.match(agents.stdout, /Read the scripted assignment/);
  assert.equal((await readdir(world.workspace)).length, 0);
});

test("removed job and remote control commands give migration guidance without touching the supplied directory", async (t) => {
  const world = await fixture(t);
  for (const command of [
    "run",
    "serve",
    "attach",
    "execute",
    "request",
    "wait",
    "steer",
    "cancel",
    "recover",
    "apply",
    "rollback",
    "reconcile",
    "background",
    "continue",
    "follow-up",
  ]) {
    const reply = await invoke([command, world.workspace]);
    assert.equal(reply.code, 2);
    assert.match(reply.stdout + reply.stderr, /removed.*Pi tools.*embedded host/);
  }
  for (const flag of ["saved", "watch", "control", "factory"])
    assert.throws(() => parseArguments(["status", world.workspace, `--${flag}`]), /Unknown option/);
  assert.equal((await readdir(world.workspace)).length, 0);
  assert.equal((await invoke(["schema", "pinata.job.v1"])).code, 2);
});

test(
  "saved CLI inspection preserves exact embedded results before and after host shutdown",
  { timeout: 40_000 },
  async (t) => {
    const world = await fixture(t);
    for (const task of ["Complete the fixture", "fail-fixture"]) {
      const directory = join(world.directory, task.startsWith("fail") ? "failed" : "completed");
      const host = await openHost({
        workspace: world.workspace,
        agentDir: world.agentDir,
        directory,
        definitionDirectories: [world.definitions],
      });
      try {
        const receipt = await host.runtime.execute(
          {
            requestId: "create",
            command: { kind: "create", workers: [{ id: "worker", agent: "fixture", task }] },
          },
          host.caller,
        );
        assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
        const waited = await host.runtime.wait({}, host.caller, AbortSignal.timeout(20_000));
        assert.equal(waited.status, "settled");
        assert.equal(waited.results.length, 1);
        assert(waited.results[0].transcript);
        const live = await invoke(["result", directory, "worker", "1"]);
        assert.equal(live.code, 0, live.stderr);
        const query = surfaceReplySchema.parse(live.values[0]);
        assert(
          query.status === "ok" &&
            query.response.method === "query" &&
            query.response.result.kind === "result",
        );
        assert.deepEqual(query.response.result.result, waited.results[0]);
        assert.equal((await host.close()).status, "closed");
        assert.deepEqual((await invoke(["result", directory, "worker", "1"])).values, live.values);
        assert.equal((await invoke(["status", directory])).code, 0);
        assert.equal((await invoke(["logs", directory])).code, 0);
        const waitFile = join(world.directory, "wait-query.json");
        await writeFile(waitFile, JSON.stringify({ kind: "wait", wait: {} }));
        assert.equal((await invoke(["query", directory, waitFile])).code, 2);
      } finally {
        await host.close();
      }
    }
  },
);
test("agents validate checks selected skill resources without opening a runtime", async (t) => {
  const f = await fixture(t);
  const path = join(f.definitions, "fixture.md");
  await writeFile(
    path,
    "---\nschemaVersion: 1\nname: fixture\nhandoffDescription: Fixture\ntools: [read]\npinata: { skills: [./missing-skill] }\n---\nRead the fixture.\n",
  );
  const args = [
    "agents",
    "validate",
    "--definitions",
    f.definitions,
    "--workspace",
    f.workspace,
    "--agent-dir",
    f.agentDir,
  ];
  const rejected = await invoke(args);
  assert.equal(rejected.code, 2);
  assert.match(rejected.stdout, /pinata.skills/);
  assert.match(rejected.stdout, /missing-skill/);
  await mkdir(join(f.definitions, "missing-skill"));
  await writeFile(
    join(f.definitions, "missing-skill", "SKILL.md"),
    "---\nname: missing-skill\ndescription: Repaired explicit resource\n---\nRead the fixture.\n",
  );
  const accepted = await invoke(args);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal((await readdir(f.workspace)).length, 0);
  assert.equal((await readdir(f.agentDir)).length, 0);
});
test(
  "embedded default and packaged-development hosts run against an HTTP loopback provider",
  { timeout: 45_000 },
  async (t) => {
    const world = await fixture(t);
    let providerRequests = 0;
    const requestPaths: Array<{
      method: string | undefined;
      url: string | undefined;
      userAgent: string | undefined;
    }> = [];
    const server = createServer(async (request, response) => {
      for await (const _bytes of request) {
        /* Drain the fixture request. */
      }
      requestPaths.push({
        method: request.method,
        url: request.url,
        userAgent: request.headers["user-agent"],
      });
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("No fixture endpoint\n");
        return;
      }
      providerRequests++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null, usage?: object) =>
        response.write(
          `data: ${JSON.stringify({ id: `fixture-${providerRequests}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
        );
      chunk({ role: "assistant", content: "Local HTTP fixture completed" }, null);
      chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    assert(address && typeof address !== "string");
    const probe = await fetch(`http://127.0.0.1:${address.port}/`, {
      headers: { "user-agent": "pinata-cli-fixture-probe" },
    });
    assert.equal(probe.status, 404);
    assert.equal(await probe.text(), "No fixture endpoint\n");
    assert.equal(providerRequests, 0, JSON.stringify(requestPaths));
    await writeFile(
      join(world.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "cli-loopback": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture-local-only",
            models: [
              {
                id: "fixture",
                name: "Local CLI fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 65536,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const packageRoot = join(world.directory, "node_modules", "pi-pinata-development");
    await mkdir(packageRoot, { recursive: true });
    const rewrite = resolve(dirname(cli), "..");
    await Promise.all(
      ["engine", "agents", "bin"].map((name) =>
        cp(join(rewrite, name), join(packageRoot, name), { recursive: true }),
      ),
    );
    await symlink(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      join(packageRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(packageRoot, "package.json"),
      '{"name":"pi-pinata-development","type":"module"}',
    );
    for (const [entry, backend] of [
      [cli, "in-process"],
      [join(packageRoot, "bin", "pinata.mjs"), "process"],
    ]) {
      const open =
        entry === cli
          ? openProductionHost
          : ((await import(pathToFileURL(join(packageRoot, "engine/host/public.mjs")).href))
              .openHost as typeof openProductionHost);
      const host = await open({
        workspace: world.workspace,
        agentDir: world.agentDir,
        definitionDirectories: [world.definitions],
        directory: join(world.directory, `http-${backend}`),
        parentModel: { provider: "cli-loopback", id: "fixture", thinking: "off" },
      });
      try {
        const receipt = await host.runtime.execute(
          {
            requestId: "loopback",
            command: {
              kind: "create",
              workers: [{ id: "worker", agent: "fixture", task: "HTTP fixture", backend }],
            },
          },
          host.caller,
        );
        assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
        const waited = await host.runtime.wait({}, host.caller, AbortSignal.timeout(30_000));
        assert.equal(waited.status, "settled");
        assert.match(waited.results[0].summary, /Local HTTP fixture completed/);
      } finally {
        await host.close();
      }
    }
    t.diagnostic(JSON.stringify(requestPaths));
    assert.equal(providerRequests, 2, JSON.stringify(requestPaths));
  },
);
