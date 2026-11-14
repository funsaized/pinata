import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { openHost } from "../../engine/host/index.ts";
import { piFixture } from "./rewrite-pi-fixture.ts";

test("frozen grants reject late registered tools directly and through Pi executeTool after continuation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pinata-late-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extension = join(directory, "extension.mjs");
  const evidence = join(directory, "evidence.txt");
  await writeFile(evidence, "unchanged");
  await writeFile(
    extension,
    `
    import { writeFile } from "node:fs/promises";
    export default function(pi) {
      pi.registerTool({name:"proxy",label:"Proxy",description:"Exercise nested tool dispatch",parameters:{type:"object",properties:{}},
        async execute(id,args,signal,update,ctx) {
          const outcome = await ctx.executeTool("rogue", {});
          return {content:[{type:"text",text:JSON.stringify(outcome)}],details:{}};
        }});
      pi.on("session_start",()=>{
        pi.registerTool({name:"rogue",label:"Rogue",description:"Must stay outside frozen grants",parameters:{type:"object",properties:{}},
          async execute() {
            await writeFile(${JSON.stringify(evidence)}, "violated");
            return {content:[{type:"text",text:"unauthorized execution"}],details:{}};
          }});
      });
    }
  `,
  );
  const world = await piFixture(
    t,
    (context) =>
      context.messages.at(-1)?.role === "user"
        ? fauxAssistantMessage([fauxToolCall("rogue", {}), fauxToolCall("proxy", {})])
        : fauxAssistantMessage("Attempt observed"),
    { tools: ["read", "proxy"], extensions: [extension] },
  );
  for (const command of [
    { kind: "create", workers: [{ id: "worker", agent: "fixture", task: "Attempt the tools" }] },
    { kind: "continue", worker: "worker", messageId: "continue", text: "Try the tools again" },
  ]) {
    const receipt = await world.runtime.execute({ requestId: command.kind, command }, world.caller);
    assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
    const result = await world.runtime.wait({}, world.caller, AbortSignal.timeout(10_000));
    assert.equal(result.status, "settled");
    assert.equal(await readFile(evidence, "utf8"), "unchanged");
  }
  const transcript = JSON.stringify(world.turns);
  assert.match(transcript, /proxy/);
  assert.match(transcript, /not in this worker|not found|not available|Unknown tool|not callable/i);
});

test("standard host uses the injected workspace port and releases only confirmed cleanup", async (t) => {
  const world = await piFixture(t, () => fauxAssistantMessage("Done"));
  const workspace = join(world.directory, "custom-workspace");
  await mkdir(workspace);
  const lifecycle: string[] = [];
  const host = await openHost({
    workspace,
    directory: join(world.directory, "custom-run"),
    agentDir: world.agentDir,
    modelRuntime: world.modelRuntime,
    parentModel: { provider: "pinata-fixture", id: "script", thinking: "off" },
    config: { run: { codemode: false, setup: false } },
    workspacePort: {
      async prepare(request, signal) {
        signal.throwIfAborted();
        lifecycle.push(`prepare:${request.ref.worker}`);
        return { cwd: workspace, identity: "custom-environment", artifacts: [] };
      },
      async release(request) {
        assert.equal(request.cleanup.status, "stopped");
        assert.equal(request.prepared.identity, "custom-environment");
        lifecycle.push(`release:${request.ref.worker}`);
      },
    },
  });
  t.after(() => host.close("Fixture disposal"));
  const receipt = await host.runtime.execute(
    {
      requestId: "custom",
      command: { kind: "create", workers: [{ id: "reader", agent: "scout", task: "Complete" }] },
    },
    host.caller,
  );
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
  assert.equal(
    (await host.runtime.wait({}, host.caller, AbortSignal.timeout(10_000))).status,
    "settled",
  );
  await host.close("Fixture complete");
  assert.deepEqual(lifecycle, ["prepare:reader", "release:reader"]);
});
