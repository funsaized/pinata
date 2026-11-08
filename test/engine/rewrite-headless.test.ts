import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { surfaceReplySchema } from "../../rewrite/engine/contracts/index.ts";
import { parseArguments } from "../../rewrite/engine/headless/arguments.ts";

const cli = fileURLToPath(new URL("../../rewrite/bin/pinata.mjs", import.meta.url));
const factory = fileURLToPath(new URL("./fixtures/rewrite-cli-factory.ts", import.meta.url));
const execute = promisify(execFile);

async function invoke(args: string[], options: { entry?: string; cwd?: string } = {}) {
  let code = 0;
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execute(
      process.execPath,
      [options.entry ?? cli, ...args, "--json"],
      { cwd: options.cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    ));
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
    "---\nschemaVersion: 3\nname: fixture\nhandoffDescription: Scripted CLI fixture\ntools: [read]\n---\nRead the scripted assignment.\n",
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hostArgs = [
    "--factory",
    factory,
    "--workspace",
    workspace,
    "--agent-dir",
    agentDir,
    "--definitions",
    definitions,
  ];
  const job = async (task = "Complete the fixture", backend = "in-process") => {
    const path = join(directory, `job-${Date.now()}-${Math.random()}.json`);
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 4,
        workers: [{ id: "worker", agent: "fixture", task, backend }],
      }),
    );
    return path;
  };
  return { directory, workspace, definitions, agentDir, hostArgs, job };
}

function launch(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes;
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes;
  });
  const exited = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => done(code));
  });
  return { child, exited, output: () => stdout, errors: () => stderr };
}
async function until(condition: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("CLI fixture condition timed out");
    await new Promise((done) => setTimeout(done, 10));
  }
}
async function stop(child: ChildProcess, exited: Promise<number | null>) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await exited;
}

test("replacement CLI discovers canonical schemas, tools and definitions without opening a host", async (t) => {
  const world = await fixture(t);
  assert.throws(() => parseArguments(["run", "--json", "--json"]), /only once/);
  assert.throws(() => parseArguments(["run", "--unknown"]), /Unknown option/);
  const schemas = await invoke(["schema", "pinata.command.v1", "--factory", "absent-module"]);
  assert.equal(schemas.code, 0, schemas.stderr);
  assert.match(schemas.stdout, /requestId/);
  const tools = await invoke(["tools"]);
  assert.equal(tools.code, 0, tools.stderr);
  assert.match(tools.stdout, /pinata_steer/);
  assert.match(tools.stdout, /pinata.surface-reply.v1/);
  const agents = await invoke(["agents", "show", "fixture", "--definitions", world.definitions]);
  assert.equal(agents.code, 0, agents.stderr);
  assert.match(agents.stdout, /Read the scripted assignment/);
});

test(
  "replacement finite CLI preserves canonical receipts, full results and factual exit codes",
  { timeout: 40_000 },
  async (t) => {
    const world = await fixture(t);
    for (const [task, expected] of [
      ["Complete the fixture", 0],
      ["fail-fixture", 1],
    ] as const) {
      const directory = join(world.directory, `run-${expected}`);
      const result = await invoke([
        "run",
        await world.job(task),
        ...world.hostArgs,
        "--directory",
        directory,
      ]);
      assert.equal(result.code, expected, result.stdout + result.stderr);
      const accepted = surfaceReplySchema.parse(result.values[0]);
      assert.equal(accepted.status, "ok");
      const waited = surfaceReplySchema.parse(result.values[1]);
      assert.equal(waited.status, "ok");
      assert(waited.status === "ok" && waited.response.method === "wait");
      assert.equal(waited.response.result.results.length, 1);
      assert(waited.response.result.results[0].transcript);
      const saved = await invoke(["result", directory, "worker", "1", "--saved"]);
      assert.equal(saved.code, 0, saved.stderr);
      const query = surfaceReplySchema.parse(saved.values[0]);
      assert(
        query.status === "ok" &&
          query.response.method === "query" &&
          query.response.result.kind === "result",
      );
      assert.deepEqual(query.response.result.result, waited.response.result.results[0]);
      assert.doesNotMatch(result.stdout, /checked|review complete|verified/i);
    }
    const invalid = join(world.directory, "invalid.json");
    await writeFile(invalid, '{"schemaVersion":4,"workers":[]}');
    assert.equal((await invoke(["run", invalid, ...world.hostArgs])).code, 2);
  },
);

test(
  "replacement CLI serve and authenticated controls retain work when an attached wait aborts",
  { timeout: 45_000 },
  async (t) => {
    const world = await fixture(t);
    const directory = join(world.directory, "served");
    const service = launch([
      "serve",
      await world.job("hold-fixture"),
      ...world.hostArgs,
      "--directory",
      directory,
    ]);
    t.after(() => stop(service.child, service.exited));
    await until(
      () => service.output().includes('"kind":"ready"') || service.child.exitCode !== null,
    );
    assert.equal(service.child.exitCode, null, service.output() + service.errors());
    await until(() => service.output().includes('"status":"accepted"'));
    const wait = launch(["wait", directory, "worker"]);
    t.after(() => stop(wait.child, wait.exited));
    await new Promise((done) => setTimeout(done, 300));
    wait.child.kill("SIGINT");
    assert.equal(await wait.exited, 3, wait.output() + wait.errors());
    const status = await invoke(["status", directory]);
    assert.equal(status.code, 0, status.stderr);
    const snapshot = surfaceReplySchema.parse(status.values[0]);
    assert(
      snapshot.status === "ok" &&
        snapshot.response.method === "query" &&
        snapshot.response.result.kind === "status",
    );
    assert(
      Object.values(snapshot.response.result.state.assignments).some(
        (assignment) => assignment.execution.phase !== "ended",
      ),
    );
    const steered = await invoke([
      "steer",
      directory,
      "worker",
      "Retain this accepted message",
      "--request-id",
      "cli-steer",
    ]);
    assert.equal(steered.code, 0, steered.stdout + steered.stderr);
    const cancelled = await invoke([
      "cancel",
      directory,
      "--scope",
      "worker",
      "--worker",
      "worker",
    ]);
    assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr);
    const terminal = await invoke(["wait", directory, "worker"]);
    assert.equal(terminal.code, 3, terminal.stdout + terminal.stderr);
    await stop(service.child, service.exited);
    assert.equal(service.child.exitCode, 0, service.output() + service.errors());
    const offline = await invoke(["status", directory]);
    assert.equal(offline.code, 0, offline.stderr);
    assert.equal(
      (await invoke(["steer", directory, "worker", "Cannot mutate saved data"])).code,
      2,
    );
  },
);

test(
  "replacement default and packaged-development CLI run against an HTTP loopback provider",
  { timeout: 45_000 },
  async (t) => {
    const world = await fixture(t);
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _bytes of request) {
        /* Drain the fixture request. */
      }
      requests++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null, usage?: object) =>
        response.write(
          `data: ${JSON.stringify({ id: `fixture-${requests}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
        );
      chunk({ role: "assistant", content: "Local HTTP fixture completed" }, null);
      chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    assert(address && typeof address !== "string");
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
      const result = await invoke(
        [
          "run",
          await world.job("HTTP fixture", backend),
          "--workspace",
          world.workspace,
          "--agent-dir",
          world.agentDir,
          "--definitions",
          world.definitions,
          "--directory",
          join(world.directory, `http-${backend}`),
          "--model",
          "cli-loopback/fixture",
        ],
        { entry },
      );
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Local HTTP fixture completed/);
    }
    assert.equal(requests, 2);
  },
);

test(
  "replacement CLI migration is dry by default and preserves historical inputs during explicit import",
  { timeout: 30_000 },
  async (t) => {
    const world = await fixture(t);
    const source = join(world.directory, "legacy");
    await mkdir(source);
    const definition = {
      schemaVersion: 2,
      access: "read",
      name: "fixture",
      description: "Legacy fixture",
      workspace: "shared",
      tools: ["read"],
      prompt: "Keep historical evidence",
      output: { require: [] },
      source: "built-in:fixture",
    };
    const digest = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
    const original = JSON.stringify({
      schemaVersion: 3,
      id: "legacy",
      root: world.workspace,
      head: "a".repeat(40),
      tasks: [{ id: "worker", agent: "fixture", task: "Historical task", definition: digest }],
      allowWrites: false,
      passEnv: [],
      definitions: { [digest]: { ...definition, digest } },
    });
    await writeFile(join(source, "run.json"), original);
    const planned = await invoke([
      "migrate-run",
      source,
      "--workspace",
      world.workspace,
      "--run",
      "imported",
    ]);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    const destination = join(world.directory, "imported");
    const imported = await invoke([
      "migrate-run",
      source,
      "--import",
      "--directory",
      destination,
      "--run",
      "imported",
      ...world.hostArgs,
    ]);
    assert.equal(imported.code, 0, imported.stdout + imported.stderr);
    assert.match(imported.stdout, /migration-import/);
    assert.equal(await readFile(join(source, "run.json"), "utf8"), original);
    const status = await invoke(["status", destination, "--saved"]);
    assert.match(status.stdout, /historical/);
    assert.match(status.stdout, /interrupted/);
    const refused = await invoke([
      "migrate-run",
      source,
      "--import",
      "--directory",
      join(source, "nested"),
      "--run",
      "nested",
      ...world.hostArgs,
    ]);
    assert.equal(refused.code, 2, refused.stdout);
    assert.match(refused.stdout, /outside retained legacy/);
  },
);
