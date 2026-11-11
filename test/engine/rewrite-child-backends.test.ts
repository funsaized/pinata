import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { openHost } from "../../engine/host/index.ts";
import { workspacePlanSchema, type ArtifactRef } from "../../engine/contracts/index.ts";
import { processArtifacts } from "../../engine/backends/process-transport.ts";
import { childLargeAnswer, installChildProvider } from "./fixtures/rewrite-child-provider.ts";
import { checkpointConversation } from "../../engine/agent/conversation.ts";
import { freezeConversationSeed, readConversationSeed } from "../../engine/context/conversation.ts";

const git = promisify(execFile);
for (const backend of ["in-process", "process"] as const)
  for (const capacity of [1, 2])
    test(
      `authorized children use ${backend} at capacity ${capacity} and inherit the parent's checkout`,
      {
        skip: !["linux", "darwin"].includes(process.platform),
        timeout: 60_000,
      },
      async (t) => {
        const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-child-backend-")));
        const workspace = join(directory, "project");
        const agentDir = join(directory, "pi");
        const definitions = join(directory, "agents");
        await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(definitions)]);
        await git("git", ["init", "--quiet", workspace]);
        await git("git", [
          "-C",
          workspace,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-qm",
          "base",
        ]);
        await writeFile(
          join(definitions, "parent.md"),
          `---
schemaVersion: 1
name: parent
handoffDescription: Delegate the fixture.
tools: [read]
handoffs: [leaf]
pinata:
  access: read
  inheritContext: ${capacity === 2 ? "parent" : "none"}
  delegation: { maxDepth: 1 }
---
Delegate the requested work.
`,
        );
        await writeFile(
          join(definitions, "leaf.md"),
          `---
schemaVersion: 1
name: leaf
handoffDescription: Complete the fixture.
tools: [read, write]
pinata:
  access: write
---
Complete the task with the tools granted by the host.
`,
        );
        const modelRuntime = await ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
          refreshOnCreate: false,
          allowModelNetwork: false,
        });
        installChildProvider(modelRuntime, agentDir);
        let parentSeed: ArtifactRef | undefined;
        const host = await openHost({
          workspace,
          directory: join(directory, "run"),
          agentDir,
          definitionDirectories: [definitions],
          modelRuntime,
          bootstrapModule: fileURLToPath(
            new URL("./fixtures/rewrite-child-provider.ts", import.meta.url),
          ),
          config: { run: { backend, codemode: false, execution: { maxConcurrent: capacity } } },
          parentModel: { provider: "child-fixture", id: "script", thinking: "off" },
          parentContext: async () => {
            assert(parentSeed);
            return parentSeed;
          },
          grants: {
            access: "write",
            tools: ["read", "write"],
            workspaces: ["shared", "worktree"],
            inheritContext: capacity === 2,
            memory: { scope: "none", access: "read" },
            delegation: {
              maxDepth: 1,
              agents: ["leaf"],
              tools: ["read"],
              workspaces: ["shared", "worktree"],
            },
          },
        });
        t.after(async () => {
          await host.close("Child fixture complete");
          await rm(directory, { recursive: true, force: true });
        });
        const artifacts = processArtifacts(host.directory);
        const parentSessions = join(directory, "parent-sessions");
        await mkdir(parentSessions);
        const parentSession = SessionManager.create(workspace, parentSessions);
        parentSession.appendMessage({ role: "user", content: "grandparent-fixture", timestamp: 1 });
        parentSeed = (
          await freezeConversationSeed({
            checkpoint: await checkpointConversation(parentSession, "coordinator", artifacts),
            artifacts,
          })
        ).artifact;
        const receipt = await host.runtime.execute(
          {
            requestId: "parent",
            command: {
              kind: "create",
              workers: [
                {
                  id: "parent",
                  agent: "parent",
                  task: capacity === 2 ? "delegate-fixture-inherit" : "delegate-fixture",
                  workspace: "worktree",
                },
              ],
            },
          },
          host.caller,
        );
        assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
        // Wait freezes current assignments, so wait again after the parent has
        // accepted its child to include both exact references in the final read.
        for (let index = 0; index < 2; index++) {
          const waited = await host.runtime.wait({}, host.caller, AbortSignal.timeout(45_000));
          assert.equal(
            waited.status,
            "settled",
            JSON.stringify({ wait: waited, diagnostics: host.runtime.diagnostics() }),
          );
        }
        const status = await host.runtime.query({ kind: "status" }, host.caller);
        assert(status.kind === "status");
        const turns = await readFile(join(agentDir, "child-turns.jsonl"), "utf8");
        const toolReplies = turns
          .trim()
          .split("\n")
          .flatMap((line) => {
            const turn = JSON.parse(line) as {
              messages: Array<{ role: string; content: unknown }>;
            };
            return turn.messages.filter((message) => message.role === "toolResult");
          });
        assert.deepEqual(
          Object.keys(status.state.workers).sort(),
          ["leaf", "parent"],
          JSON.stringify(toolReplies),
        );
        const parent = status.state.workers.parent;
        const leaf = status.state.workers.leaf;
        assert.equal(leaf.depth, 1);
        assert.equal(leaf.access, "read");
        assert.deepEqual(leaf.tools, ["read"]);
        assert.equal(leaf.grants.delegation.maxDepth, 0);
        assert.equal(leaf.parentAssignment?.worker, "parent");
        assert(parent.workspacePlan && leaf.workspacePlan);
        const parentPlan = workspacePlanSchema.parse(
          JSON.parse(Buffer.from(await artifacts.read(parent.workspacePlan)).toString()),
        );
        const childPlan = workspacePlanSchema.parse(
          JSON.parse(Buffer.from(await artifacts.read(leaf.workspacePlan)).toString()),
        );
        assert.notEqual(parentPlan.destination, workspace);
        assert.equal(childPlan.destination, parentPlan.destination);
        if (capacity === 2) {
          assert(leaf.context);
          const inherited = await readConversationSeed(leaf.context, artifacts);
          assert.match(JSON.stringify(inherited.messages), /delegate-fixture-inherit/);
          assert.match(JSON.stringify(inherited.messages), /grandparent-fixture/);
        }
        for (const stored of Object.values(status.state.results)) {
          assert.equal(
            stored.result.execution.phase === "ended" && stored.result.execution.reason,
            "completed",
            JSON.stringify(stored),
          );
          assert.equal(stored.result.usage.complete, true);
        }
        const parentResult = Object.values(status.state.results).find(
          (stored) => stored.result.ref.worker === "parent",
        );
        assert.equal(
          parentResult?.result.summary,
          capacity === 1 ? "parent-yielded" : "parent-completed",
        );
        assert.equal(
          Object.values(status.state.results).find((stored) => stored.result.ref.worker === "leaf")
            ?.result.summary,
          capacity === 2 ? childLargeAnswer : "child-completed",
        );
        assert.match(turns, /pinata_children/);
        if (capacity === 2) assert.match(turns, /"toolName":"pinata_page"/);
        assert.doesNotMatch(turns, /"name":"pinata_run"/);
      },
    );
