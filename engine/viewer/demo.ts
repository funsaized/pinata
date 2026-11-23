import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackendOutcome,
  BackendPort,
  CallerAuthority,
  InboxMessage,
  SessionCheckpoint,
} from "../contracts/index.ts";
import { Runtime } from "../runtime/index.ts";
import { bindRuntime, type RuntimeSource } from "../sources/runtime.ts";
import { storeConversation } from "../storage/conversation.ts";

const backend: BackendPort = {
  kind: "in-process",
  capabilities: {
    available: true,
    steer: true,
    continuation: false,
    conversationSeed: false,
    surviving: false,
    cleanup: "confirmed",
  },
  async start(launch, observe, signal) {
    signal.throwIfAborted();
    const { ref, attemptId, artifacts } = launch;
    const identity = { id: attemptId, ownerEpoch: launch.ownerEpoch, kind: "in-process" as const };
    const evidence = await artifacts.put(Buffer.from(JSON.stringify(identity)));
    await observe({ kind: "enrolled", identity, evidence: [evidence] });
    const entries: {
      type: string;
      id: string;
      parentId: string | null;
      message: { role: string; content: string };
    }[] = [];
    function append(role: string, content: string) {
      entries.push({
        type: "message",
        id: String(entries.length + 1),
        parentId: entries.at(-1)?.id ?? null,
        message: { role, content },
      });
    }
    append("user", launch.brief.task);
    append(
      "assistant",
      ref.worker === "scout"
        ? "I'm tracing the old CLI parser. Send a correction to point me at the HTTP parser."
        : "The HTTP parser is ready for review. Send a message to finish the demo.",
    );
    async function checkpoint(): Promise<SessionCheckpoint> {
      const branch = String(entries.length);
      const records = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      const artifact = await artifacts.put(
        Buffer.from(JSON.stringify({ type: "session", id: attemptId }) + "\n" + records),
      );
      const transcript = await storeConversation(
        Buffer.from(records),
        { kind: "assignment", ref, session: attemptId, fromEntry: null, throughEntry: branch },
        artifacts,
      );
      return {
        format: "scripted",
        id: attemptId,
        worker: ref.worker,
        branch,
        artifact,
        transcript,
      };
    }
    let finish: (value: BackendOutcome) => void = () => {};
    const done = new Promise<BackendOutcome>((resolve) => {
      finish = resolve;
    });
    async function outcome(
      reason: BackendOutcome["reason"],
      summary: string,
    ): Promise<BackendOutcome> {
      const session = await checkpoint();
      return {
        reason,
        summary,
        session,
        transcript: session.transcript,
        artifacts: [],
        usage: {
          expectedAttempts: [attemptId],
          observations: [
            {
              attempt: attemptId,
              source: attemptId,
              kind: "attempt_total",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            },
          ],
          complete: true,
        },
      };
    }
    async function steer(message: InboxMessage) {
      append("user", message.text);
      const summary =
        ref.worker === "scout"
          ? "Correction received. The HTTP parser is in server/parser.ts. Press Esc to return to the reviewer in the fleet."
          : "Review complete. Press Esc, then h to inspect both results.";
      append("assistant", summary);
      const completed = await outcome("completed", summary);
      if (completed.session)
        await observe({
          kind: "input_consumed",
          messageId: message.id,
          checkpoint: completed.session.artifact,
          entryId: completed.session.branch,
        });
      finish(completed);
    }
    const initial = await checkpoint();
    for (const message of launch.initialMessages) {
      if (message.kind === "steer") await steer(message);
      else
        await observe({
          kind: "input_consumed",
          messageId: message.id,
          checkpoint: initial.artifact,
          entryId: initial.branch,
        });
    }
    return {
      identity,
      done,
      checkpoint,
      async input(message) {
        await steer(message);
        return { status: "transport_handled" };
      },
      async stop(reason) {
        finish(await outcome("cancelled", reason));
        return {
          cleanup: {
            status: "stopped",
            ownerEpoch: launch.ownerEpoch,
            identities: [identity.id],
            evidence: [evidence],
          },
        };
      },
    };
  },
};

export async function withDemoFleet(view: (source: RuntimeSource) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-demo-")));
  const caller: CallerAuthority = {
    id: "coordinator",
    kind: "coordinator",
    run: "offline-demo",
    grants: {
      access: "read",
      tools: [],
      workspaces: ["shared"],
      inheritContext: false,
      memory: { scope: "none", access: "read" },
      delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
    },
  };
  const runtime = await Runtime.open({
    directory,
    manifest: {
      schemaVersion: 1,
      run: caller.run,
      workspace: directory,
      store: directory,
      createdAt: new Date().toISOString(),
    },
    async resolveWorkers(requests, _authority, artifacts) {
      const definition = await artifacts.putArtifact(Buffer.from("Offline parser walkthrough"));
      return requests.map(({ id, agent }) => ({
        id,
        agent,
        definition,
        fallbacks: [],
        tools: [],
        access: "read",
        workspace: "shared",
        backend: "in-process",
        lifetime: "attached",
        depth: 0,
        grants: caller.grants,
      }));
    },
    execution: {
      backends: { "in-process": backend },
      workspace: {
        async prepare({ ref }) {
          return { identity: ref.worker, cwd: directory, artifacts: [] };
        },
        async release() {},
      },
    },
  });
  async function closeDemo() {
    const closed = await runtime.close({ reason: "Demo closed" });
    if (closed.status !== "closed")
      throw new Error("Demo cleanup unconfirmed. Retained evidence in " + directory);
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const receipt = await runtime.execute(
      {
        requestId: "start-demo",
        command: {
          kind: "create",
          workers: [
            {
              id: "review",
              agent: "reviewer",
              task: "Press Right, then Enter to open the scout conversation. Ask the scout to trace the HTTP parser.",
              after: ["scout"],
            },
            { id: "scout", agent: "scout", task: "Locate the parser entry point." },
          ],
        },
      },
      caller,
    );
    if (receipt.status === "rejected") throw new Error(receipt.error.message);
    await view(bindRuntime(runtime, caller));
  } finally {
    await closeDemo();
  }
}
