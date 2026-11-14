import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { commandEnvelopeSchema, configSchema, grantsSchema } from "../../engine/contracts/index.ts";
import { discoverDefinitions } from "../../engine/definitions/index.ts";
import { openHost } from "../../engine/host/index.ts";
import { checkReference } from "../../scripts/reference.ts";
import { checkPublicApi, publicApiFiles } from "../../scripts/public-api.ts";
import { setup } from "../../examples/relay/setup.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const finished = fileURLToPath(new URL("./fixtures/relay", import.meta.url));
const execute = promisify(execFile);

test("all published fleet commands, grants, definitions and generated API boundaries validate", async () => {
  const examples = join(root, "examples");
  const files = await readdir(examples, { recursive: true });
  const definitions = await discoverDefinitions([join(root, "agents"), join(examples, "agents")]);
  const names = new Set(definitions.map(({ definition }) => definition.name));
  for (const file of files.filter((file) => file.endsWith(".json") && !file.includes("starter"))) {
    const input = JSON.parse(await readFile(join(examples, file), "utf8"));
    if (file.endsWith("grants.json")) grantsSchema.parse(input);
    else if (input.command) {
      const { command } = commandEnvelopeSchema.parse(input);
      if (command.kind !== "create" && command.kind !== "add") continue;
      const ids = new Set(command.workers.map((worker) => worker.id));
      for (const worker of command.workers) {
        assert(names.has(worker.agent), `${file} names unknown definition ${worker.agent}`);
        for (const predecessor of worker.after)
          if (typeof predecessor === "string")
            assert(ids.has(predecessor), `${file}: ${predecessor}`);
      }
    } else configSchema.parse(input);
  }
  await checkReference(join(root, "docs/reference"));
  await checkPublicApi();
  const api = await readFile(join(root, "README.md"), "utf8");
  const publicEntry = await readFile(join(root, "engine/index.ts"), "utf8");
  for (const [path, content] of await publicApiFiles())
    for (const [, name] of content.matchAll(/export const ([A-Za-z_$][\w$]*)/g))
      assert(api.includes(`\`${name}\``), `${path}: public value ${name} has no API reference`);
  for (const group of publicEntry.matchAll(/export (?:type )?\{([^}]+)\}/g))
    for (const name of group[1]
      .split(",")
      .map((name) => name.trim().replace(/^type /, ""))
      .filter(Boolean))
      assert(api.includes(`\`${name}\``), `Public export ${name} has no API reference`);
});

async function runNode(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    return { code: 0, ...(await execute(process.execPath, args, { cwd, env, timeout: 30_000 })) };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      typeof error.code !== "number" ||
      !("stdout" in error) ||
      !("stderr" in error)
    )
      throw error;
    return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}

async function relay(t: TestContext, wrong = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-relay-v1-")));
  const workspace = join(directory, "exercise with spaces");
  await setup(workspace);
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ provider: "relay-fixture", models: [{ id: "script" }] });
  faux.setResponses(
    Array.from({ length: 100 }, () => async (context) => {
      const task = JSON.stringify(context.messages).match(
        /RELAY:(parse|summarize|render|cli)/,
      )?.[1];
      if (!task || context.messages.at(-1)?.role !== "user")
        return fauxAssistantMessage(
          "Scripted Relay completion; coordinator checks remain separate.",
        );
      const paths = [task === "cli" ? "bin/relay.mjs" : `src/${task}.mjs`, `test/${task}.test.mjs`];
      return fauxAssistantMessage(
        await Promise.all(
          paths.map(async (path) =>
            fauxToolCall("write", {
              path,
              content:
                wrong && path === "bin/relay.mjs"
                  ? 'console.log("wrong report");\n'
                  : await readFile(join(finished, path), "utf8"),
            }),
          ),
        ),
        { stopReason: "toolUse" },
      );
    }),
  );
  modelRuntime.registerNativeProvider(faux.provider);
  const host = await openHost({
    workspace,
    agentDir,
    directory: join(directory, "run"),
    modelRuntime,
    definitionDirectories: [join(root, "agents")],
    parentModel: { provider: "relay-fixture", id: "script", thinking: "off" },
    onDiagnostic: (diagnostic) => t.diagnostic(JSON.stringify(diagnostic)),
  });
  t.after(async () => {
    await host.close("Relay fixture finished");
    await rm(directory, { recursive: true, force: true });
  });
  const { command } = commandEnvelopeSchema.parse(
    JSON.parse(await readFile(join(workspace, "fleet.json"), "utf8")),
  );
  assert(command.kind === "create");
  const result = await host.runtime.execute(
    {
      requestId: "relay/create",
      command: {
        kind: "create",
        workers: command.workers,
        config: { setup: false, codemode: false, mode: "observe" },
      },
    },
    host.caller,
  );
  assert.equal(result.status, "accepted", JSON.stringify(result));
  const completed = await host.runtime.wait({}, host.caller, AbortSignal.timeout(60_000));
  assert.equal(
    completed.status,
    "settled",
    JSON.stringify(await host.runtime.query({ kind: "status" }, host.caller)),
  );
  assert.equal(completed.results.length, command.workers.length);
  for (const result of completed.results) {
    assert.equal(result.snapshot, undefined);
    assert.equal(result.execution.phase, "ended", JSON.stringify(result));
    if (result.execution.phase === "ended") {
      assert.equal(result.execution.reason, "completed", JSON.stringify(result));
      assert.equal(result.execution.cleanup, "confirmed");
    }
  }
  const status = await host.runtime.query({ kind: "status" }, host.caller);
  assert.equal(status.kind, "status");
  if (status.kind === "status")
    assert.equal(
      Object.values(status.state.effects).some((entry) => entry.effect.kind === "capture"),
      false,
    );
  return { directory, workspace, host };
}

test("published Relay starter refuses overwrite and completes through real shared sessions", async (t) => {
  const world = await relay(t);
  const verification = await runNode(world.workspace, ["verify.mjs"]);
  assert.equal(verification.code, 0, verification.stderr);
  const checks = await runNode(world.workspace, ["--test"]);
  assert.equal(checks.code, 0, checks.stdout + checks.stderr);
  const edited = "// retained user edit\n";
  await writeFile(join(world.workspace, "src/parse.mjs"), edited);
  await assert.rejects(setup(world.workspace), { code: "EEXIST" });
  assert.equal(await readFile(join(world.workspace, "src/parse.mjs"), "utf8"), edited);
  const git = await execute("git", ["-C", world.workspace, "log", "--format=%s"]);
  assert.equal(git.stdout.trim(), "Relay exercise starting point");
  const index = await execute("git", ["-C", world.workspace, "diff", "--cached", "--name-only"]);
  assert.equal(index.stdout, "");
});

test("a completed Relay assignment preserves wrong output for coordinator correction", async (t) => {
  const world = await relay(t, true);
  assert.notEqual((await runNode(world.workspace, ["verify.mjs"])).code, 0);
  assert.match(await readFile(join(world.workspace, "bin/relay.mjs"), "utf8"), /wrong report/);
});
