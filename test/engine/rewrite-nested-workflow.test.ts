import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  grantsSchema,
  childWaitResultSchema,
  type LaunchInfo,
} from "../../engine/contracts/index.ts";
import { parseDefinitionMarkdown } from "../../engine/definitions/index.ts";
import { delegationAvailability } from "../../engine/pi/discovery.ts";
import { openHost } from "../../engine/host/index.ts";
import { assignmentTree } from "../../engine/ui/tree.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const grants = grantsSchema.parse(
  JSON.parse(await readFile(join(root, "examples/recipes/grants.json"), "utf8")),
);
const definitions = await Promise.all(
  ["examples/agents/delegator.md", "agents/builder.md"].map(async (path) => ({
    ...parseDefinitionMarkdown(await readFile(join(root, path), "utf8"), path),
    digest: "a".repeat(64),
  })),
);
const launch: LaunchInfo = {
  grants,
  parentContextAvailable: false,
  backend: "in-process",
  workspace: "shared",
  models: {},
  backends: {
    "in-process": {
      available: true,
      delegation: true,
      steer: true,
      continuation: true,
      conversationSeed: false,
      surviving: false,
      cleanup: "confirmed",
    },
  },
};

test("nested planning is gated by definitions, host grants, discovered handoffs and backend", () => {
  const available = delegationAvailability(definitions, launch);
  assert.deepEqual(available.get("delegator"), {
    enabled: true,
    maxDepth: 1,
    access: "write",
    agents: ["builder"],
    tools: grants.delegation.tools,
    workspaces: ["shared"],
  });
  assert.equal(available.get("builder")?.enabled, false);
  for (const altered of [
    undefined,
    { ...launch, grants: { ...grants, delegation: { ...grants.delegation, maxDepth: 0 } } },
    { ...launch, grants: { ...grants, delegation: { ...grants.delegation, agents: [] } } },
    { ...launch, grants: { ...grants, delegation: { ...grants.delegation, workspaces: [] } } },
    { ...launch, grants: { ...grants, tools: [] } },
    { ...launch, backends: {} },
    {
      ...launch,
      backends: { "in-process": { ...launch.backends["in-process"], delegation: false } },
    },
  ])
    assert.equal(delegationAvailability(definitions, altered).get("delegator")?.enabled, false);
  assert.equal(delegationAvailability([definitions[0]], launch).get("delegator")?.enabled, false);
  assert.equal(
    delegationAvailability(
      [
        {
          ...definitions[0],
          definition: {
            ...definitions[0].definition,
            pinata: { ...definitions[0].definition.pinata, delegation: { maxDepth: 2 } },
          },
        },
        definitions[1],
      ],
      launch,
    ).get("delegator")?.enabled,
    false,
  );
});

for (const capacity of [1, 3])
  test(
    `shipped nested recipe batches children, delivers results and synthesizes at capacity ${capacity}`,
    { timeout: 30_000 },
    async (t) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-nested-workflow-")));
      const workspace = join(directory, "project");
      const agentDir = join(directory, "agent");
      await Promise.all([mkdir(workspace), mkdir(agentDir)]);
      await promisify(execFile)("git", ["init", "--quiet", workspace]);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const provider = fauxProvider({
        provider: "nested-example",
        models: [{ id: "script", contextWindow: 200_000, maxTokens: 4096 }],
      });
      let batches = 0;
      let waits = 0;
      let turns = 0;
      provider.setResponses(
        Array.from({ length: 20 }, () => async (context) => {
          turns++;
          const isParent = context.messages.some(
            (message) =>
              message.role === "system" && JSON.stringify(message).includes("pinata_children"),
          );
          if (!isParent) return fauxAssistantMessage("child evidence");
          const submitted = context.messages.some(
            (message) => message.role === "toolResult" && message.toolName === "pinata_children",
          );
          if (!submitted) {
            batches++;
            return fauxAssistantMessage([
              fauxToolCall("pinata_children", {
                requestId: "team/batch",
                command: {
                  kind: "add",
                  workers: ["team-a", "team-b"].map((id) => ({
                    id,
                    agent: "builder",
                    task: `Inspect ${id} and report evidence without editing files.`,
                  })),
                },
              }),
            ]);
          }
          const latestUser = context.messages.findLast((message) => message.role === "user");
          const followUp = JSON.stringify(latestUser).includes("Synthesize existing children");
          const results = context.messages.filter(
            (message) =>
              message.role === "toolResult" && message.toolName === "pinata_child_status",
          );
          if (followUp) {
            if (!results.length)
              return fauxAssistantMessage(
                ["team-a", "team-b"].map((worker) =>
                  fauxToolCall("pinata_child_status", {
                    kind: "result",
                    ref: { worker, assignment: 1 },
                  }),
                ),
              );
            assert.equal(results.length, 2);
            for (const result of results) assert.match(JSON.stringify(result), /child evidence/);
            return fauxAssistantMessage("Synthesis from child evidence");
          }
          const waited = context.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "pinata_child_wait",
          );
          if (!waited || waited.role !== "toolResult") {
            waits++;
            return fauxAssistantMessage([
              fauxToolCall("pinata_child_wait", { workers: ["team-a", "team-b"] }),
            ]);
          }
          const text = waited.content.find((part) => part.type === "text");
          assert(text?.type === "text");
          const receipt = childWaitResultSchema.parse(JSON.parse(text.text));
          if (capacity === 1) {
            assert.equal(receipt.status, "capacity_blocked");
            return fauxAssistantMessage("Yielded: team-a/1 and team-b/1 need synthesis");
          }
          assert.equal(receipt.status, "settled");
          assert.equal(receipt.results.length, 2);
          assert(receipt.results.every((result) => result.summary === "child evidence"));
          return fauxAssistantMessage("Synthesis from child evidence");
        }),
      );
      modelRuntime.registerNativeProvider(provider.provider);
      const host = await openHost({
        workspace,
        agentDir,
        directory: join(directory, "run"),
        modelRuntime,
        definitionDirectories: [join(root, "agents"), join(root, "examples/agents")],
        grants,
        parentModel: { provider: "nested-example", id: "script", thinking: "off" },
        config: { run: { codemode: false, execution: { maxConcurrent: capacity } } },
      });
      t.after(async () => {
        await host.close("Nested example finished");
        await rm(directory, { recursive: true, force: true });
      });
      const discovered = await host.runtime.query({ kind: "definitions" }, host.caller);
      assert.equal(discovered.kind, "definitions");
      if (discovered.kind !== "definitions") throw new Error("Expected definitions");
      assert.equal(
        delegationAvailability(discovered.definitions, discovered.launch).get("delegator")?.enabled,
        true,
      );
      const created = await host.runtime.execute(
        {
          requestId: "lead",
          command: {
            kind: "create",
            workers: [
              {
                id: "team",
                agent: "delegator",
                task: "Coordinate two independent inspections and synthesize their evidence.",
              },
            ],
          },
        },
        host.caller,
      );
      assert.equal(created.status, "accepted", JSON.stringify(created));
      for (let index = 0; index < 2; index++)
        await host.runtime.wait({}, host.caller, AbortSignal.timeout(20_000));
      const status = await host.runtime.query({ kind: "status" }, host.caller);
      assert(status.kind === "status");
      const parent = { run: host.caller.run, worker: "team", assignment: 1 };
      for (const id of ["team-a", "team-b"]) {
        assert.deepEqual(status.state.workers[id].parentAssignment, parent);
        assert.equal(status.state.workers[id].depth, 1);
        assert.equal(status.state.workers[id].grants.delegation.maxDepth, 0);
      }
      const tree = assignmentTree(status.state);
      assert.equal(tree.length, 3);
      assert.equal(tree[0].hasChildren, true);
      assert(tree.slice(1).every((node) => node.prefix.startsWith("   ")));
      assert.equal(
        Object.values(status.state.inbox).filter((message) => message.kind === "notice").length,
        2,
      );
      if (capacity === 1) {
        const receipt = await host.runtime.execute(
          {
            requestId: "synthesize",
            command: {
              kind: "follow_up",
              worker: "team",
              messageId: "synthesis",
              text: "Synthesize existing children; do not create any more.",
              after: ["team-a", "team-b"].map((worker) => ({
                run: host.caller.run,
                worker,
                assignment: 1,
              })),
            },
          },
          host.caller,
        );
        assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
        const waited = await host.runtime.wait(
          { workers: ["team"] },
          host.caller,
          AbortSignal.timeout(20_000),
        );
        assert.equal(waited.results[0]?.summary, "Synthesis from child evidence");
      }
      assert.equal(batches, 1);
      assert.equal(waits, 1);
      assert(turns <= 7, `Unexpected extra coordination turns: ${turns}`);
    },
  );
