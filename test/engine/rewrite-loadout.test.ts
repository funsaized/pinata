import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { openHost } from "../../engine/host/index.ts";
import { processArtifacts } from "../../engine/backends/process-transport.ts";
import { freezeConversationSeed } from "../../engine/context/conversation.ts";
import { MemoryStore } from "../../engine/memory/index.ts";
import { type ArtifactRef, type SessionCheckpoint } from "../../engine/contracts/index.ts";
import { installLoadoutProvider } from "./fixtures/rewrite-loadout-provider.ts";

for (const backend of ["in-process", "process"] as const)
  test(
    `host resolves frozen skills, scoped memory, fresh instructions and parent context through ${backend}`,
    {
      skip: backend === "process" && !["linux", "darwin"].includes(process.platform),
      timeout: 40_000,
    },
    async (t) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-loadout-")));
      const workspace = join(directory, "project");
      const agentDir = join(directory, "pi");
      const definitions = join(directory, "definitions");
      const skill = join(definitions, "frozen-skill");
      await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(skill, { recursive: true })]);
      const skillFile = join(skill, "SKILL.md");
      await writeFile(
        skillFile,
        "---\nname: frozen-skill\ndescription: frozen-description\n---\nfrozen-body\n",
      );
      await writeFile(
        join(definitions, "reader.md"),
        `---
schemaVersion: 3
name: reader
handoffDescription: Exercise resolved resources.
tools: [read]
pinata:
  access: read
  skills: [./frozen-skill]
  inheritContext: parent
  memory: { scope: project-agent, access: write }
---
definition-instructions
`,
      );
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      installLoadoutProvider(modelRuntime, agentDir);
      let seed: ArtifactRef | undefined;
      const host = await openHost({
        workspace,
        directory: join(directory, "run"),
        agentDir,
        definitionDirectories: [definitions],
        modelRuntime,
        bootstrapModule: fileURLToPath(
          new URL("./fixtures/rewrite-loadout-provider.ts", import.meta.url),
        ),
        config: {
          run: {
            backend,
            codemode: false,
            models: {
              default: { provider: "loadout-fixture", id: "unavailable-primary", thinking: "off" },
            },
            fallbacks: {
              default: [{ provider: "loadout-fixture", id: "script", thinking: "off" }],
            },
          },
        },
        parentModel: { provider: "loadout-fixture", id: "script", thinking: "off" },
        parentContext: async () => {
          if (!seed) throw new Error("Fixture parent seed unavailable");
          return seed;
        },
        grants: {
          access: "read",
          tools: ["read"],
          workspaces: ["shared"],
          inheritContext: true,
          memory: { scope: "project-agent", access: "write" },
          delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
        },
      });
      t.after(async () => {
        await host.close("Loadout fixture complete");
        await rm(directory, { recursive: true, force: true });
      });
      const artifacts = processArtifacts(host.directory);
      const parent = SessionManager.inMemory(workspace);
      parent.appendMessage({ role: "user", content: "inherited-parent-marker", timestamp: 1 });
      parent.appendMessage(fauxAssistantMessage("inherited-completed-answer"));
      parent.appendCustomEntry("private-host-control", { token: "never-inherit-control" });
      const branch = parent.getLeafId();
      assert(branch);
      const checkpoint: SessionCheckpoint = {
        id: parent.getSessionId(),
        worker: "parent",
        branch,
        format: "pi",
        producerVersion: "fixture",
        artifact: await artifacts.put(
          Buffer.from(
            [parent.getHeader(), ...parent.getEntries()]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
          ),
        ),
      };
      seed = (await freezeConversationSeed({ checkpoint, artifacts })).artifact;
      parent.appendMessage({ role: "user", content: "later-parent-not-inherited", timestamp: 2 });
      const first = await host.runtime.execute(
        {
          requestId: "first",
          command: {
            kind: "create",
            workers: [{ id: "reader", agent: "reader", task: "first-fixture" }],
          },
        },
        host.caller,
      );
      assert.equal(first.status, "accepted", JSON.stringify(first));
      const ended = await host.runtime.wait({}, host.caller, AbortSignal.timeout(25_000));
      assert.equal(ended.status, "settled", JSON.stringify(host.runtime.diagnostics()));
      assert.equal(
        ended.results[0].execution.phase === "ended" && ended.results[0].execution.reason,
        "completed",
        JSON.stringify(ended.results[0]),
      );
      const firstTurns = await readFile(join(agentDir, "turns.jsonl"), "utf8");
      assert.match(firstTurns, /inherited-parent-marker/);
      assert.match(firstTurns, /frozen-description/);
      assert.doesNotMatch(firstTurns, /later-parent-not-inherited|never-inherit-control/);
      await writeFile(
        skillFile,
        "---\nname: frozen-skill\ndescription: changed-description\n---\nchanged-body\n",
      );
      await writeFile(join(workspace, "AGENTS.md"), "fresh-project-instructions");
      const follow = await host.runtime.execute(
        {
          requestId: "follow",
          command: {
            kind: "follow_up",
            worker: "reader",
            messageId: "next",
            text: "remember-fixture",
          },
        },
        host.caller,
      );
      assert.equal(follow.status, "accepted", JSON.stringify(follow));
      const second = await host.runtime.wait({}, host.caller, AbortSignal.timeout(25_000));
      assert.equal(second.status, "settled", JSON.stringify(host.runtime.diagnostics()));
      assert.equal(
        second.results[0].execution.phase === "ended" && second.results[0].execution.reason,
        "completed",
        JSON.stringify(second.results[0]),
      );
      const turns = (await readFile(join(agentDir, "turns.jsonl"), "utf8")).trim().split("\n");
      const last = turns.at(-1) ?? "";
      assert.match(last, /fresh-project-instructions/);
      assert.match(last, /frozen-body/);
      assert.doesNotMatch(last, /changed-description|changed-body/);
      const status = await host.runtime.query({ kind: "status" }, host.caller);
      assert(status.kind === "status");
      const memory = await MemoryStore.open({
        project: workspace,
        run: host.caller.run,
        worker: status.state.workers.reader,
      });
      assert.equal((await memory.read()).value?.text, "retained-fixture-note");
      assert.equal((await memory.read()).revision, 1);
      assert.equal(status.state.workers.reader.access, "read");
      assert.deepEqual(status.state.workers.reader.tools, ["read"]);
    },
  );
