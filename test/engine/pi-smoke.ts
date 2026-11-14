// Real Pi RPC integration using only a native scripted provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandReceiptSchema, surfaceReplySchema } from "../../engine/contracts/index.ts";
import { piCommand, record, rpc } from "./rewrite-smoke-rpc.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export async function runPiSmoke(options: { packageRoot?: string; installed?: boolean } = {}) {
  const packageRoot = options.packageRoot ?? root;
  const directory = await mkdtemp(join(tmpdir(), "pinata-rewrite-pi-smoke-"));
  const workspace = join(directory, "workspace");
  const agent = join(directory, "agent");
  await Promise.all([mkdir(workspace), mkdir(agent)]);
  await writeFile(join(workspace, "README.md"), "# Real Pi scripted fixture\n");
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({ quietStartup: true, retry: { enabled: false } }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  delete env.PINATA_AGENT;
  const [piBinary, ...piArgs] = piCommand();
  const version = spawnSync(piBinary, [...piArgs, "--version"], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(version.status, 0, version.stderr || version.stdout);
  if (options.installed) {
    const [binary, ...args] = piCommand();
    const installed = spawnSync(binary, [...args, "install", packageRoot, "--no-approve"], {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  }
  const pi = rpc(
    [
      ...piCommand(),
      "--mode",
      "rpc",
      "--session",
      join(directory, "parent.jsonl"),
      "--offline",
      ...(!options.installed
        ? ["--no-extensions", "--extension", join(packageRoot, "engine", "pi", "extension.ts")]
        : []),
      ...(!options.installed ? ["--no-skills", "--no-prompt-templates"] : []),
      "--no-themes",
      "--no-context-files",
      "--extension",
      join(root, "test", "engine", "fixtures", "rewrite-smoke-provider.ts"),
      "--provider",
      "rewrite-smoke",
      "--model",
      "script",
      "--thinking",
      "off",
    ],
    { cwd: workspace, env },
  );
  try {
    const commandId = pi.send({ type: "get_commands" });
    const commandReply = await pi.wait(
      (event) => event.type === "response" && event.id === commandId,
    );
    const commands = record(commandReply.data).commands;
    assert(Array.isArray(commands));
    const names = commands.map((entry: unknown) => record(entry).name);
    for (const name of [
      "pinata",
      "pinata-fleet",
      "pinata-conversation",
      "pinata-schema",
      "pinata-new",
      "pinata-grants",
      "pinata-memory",
      "pinata-retry",
    ])
      assert(names.includes(name), `Missing packaged command ${name}`);
    if (options.installed) {
      for (const name of [
        "skill:subagents",
        "scout",
        "builder",
        "reviewer",
        "pinata-review",
        "pinata-fix",
      ])
        assert(names.includes(name), `Missing packaged command ${name}`);
      for (const name of ["planner", "researcher"])
        assert(!names.includes(name), `Retired opt-in prompt ${name} was installed`);
    }
    const from = pi.records.length;
    pi.send({ type: "prompt", message: "smoke-coordinator: launch the scripted dependency graph" });
    const run = await pi.wait(
      (event) => event.type === "tool_execution_end" && event.toolName === "pinata_run",
      from,
    );
    const accepted = surfaceReplySchema.parse(record(run.result).details);
    assert(
      accepted.status === "ok" &&
        accepted.response.method === "execute" &&
        accepted.response.result.status === "accepted",
      JSON.stringify(run),
    );
    assert.equal(accepted.response.result.assignments.length, 4);
    const wait = await pi.wait(
      (event) => event.type === "tool_execution_end" && event.toolName === "pinata_wait",
      from,
    );
    const settled = surfaceReplySchema.parse(record(wait.result).details);
    assert(settled.status === "ok" && settled.response.method === "wait", JSON.stringify(wait));
    assert.equal(settled.response.result.results.length, 4);
    assert(
      settled.response.result.results.every(
        (result) =>
          result.execution.phase === "ended" &&
          result.execution.reason === "completed" &&
          result.transcript,
      ),
    );
    await pi.wait((event) => event.type === "agent_settled", from);
    const direct = pi.records.length;
    const schemaId = pi.send({ type: "prompt", message: "/pinata-schema pinata.command.v2" });
    const schemaReply = await pi.wait(
      (event) => event.type === "response" && event.id === schemaId,
      direct,
    );
    assert.equal(schemaReply.success, true, JSON.stringify(schemaReply));
    await pi.wait(
      (event) =>
        event.type === "message_end" && JSON.stringify(event.message).includes("pinata.schema.v1"),
      direct,
    );
    assert(
      !pi.records.slice(direct).some((event) => event.type === "agent_start"),
      "Schema command requested a coordinator turn",
    );
    const addressedFrom = pi.records.length;
    const addressedId = pi.send({ type: "prompt", message: "@scout-1 Read README once more" });
    const addressedReply = await pi.wait(
      (event) => event.type === "response" && event.id === addressedId,
      addressedFrom,
    );
    assert.equal(addressedReply.success, true, JSON.stringify(addressedReply));
    const addressed = await pi.wait(
      (event) =>
        event.type === "message_end" && record(event.message).customType === "pinata.addressed.v1",
      addressedFrom,
    );
    const addressedMessage = record(addressed.message);
    const followUp = commandReceiptSchema.parse(addressedMessage.details);
    assert(followUp.status === "accepted");
    assert.deepEqual(followUp.assignments, [
      { run: settled.response.result.results[0].ref.run, worker: "scout-1", assignment: 2 },
    ]);
    assert.equal(typeof addressedMessage.content, "string");
    const retry = record(JSON.parse(String(addressedMessage.content))).retry;
    assert.equal(typeof retry, "string");
    const retriedFrom = pi.records.length;
    const retryId = pi.send({ type: "prompt", message: retry });
    const retryReply = await pi.wait(
      (event) => event.type === "response" && event.id === retryId,
      retriedFrom,
    );
    assert.equal(retryReply.success, true, JSON.stringify(retryReply));
    const retried = await pi.wait(
      (event) =>
        event.type === "message_end" && record(event.message).customType === "pinata.addressed.v1",
      retriedFrom,
    );
    assert.deepEqual(commandReceiptSchema.parse(record(retried.message).details), followUp);
    await pi.wait(
      (event) =>
        event.type === "message_end" &&
        record(event.message).customType === "pinata.completion.v1" &&
        String(record(event.message).content).includes("scout-1/2: completed."),
      addressedFrom,
    );
    assert(
      !pi.records.slice(addressedFrom).some((event) => event.type === "agent_start"),
      "Addressing or retry requested a coordinator turn",
    );
    const parent = await readFile(join(directory, "parent.jsonl"), "utf8");
    assert.match(parent, /pinata.runtime.v1/);
    assert.match(parent, /pinata.input.v1/);
    return {
      ok: true,
      assignments: 5,
      commands: names.length,
      realPi: piCommand(),
      piVersion: version.stdout.trim(),
      node: process.version,
      provider: "scripted",
      packageRoot,
    };
  } finally {
    await pi.close();
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  console.log(JSON.stringify(await runPiSmoke()));
