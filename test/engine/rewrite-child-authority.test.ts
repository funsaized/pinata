import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import {
  assignmentKey,
  type BackendOutcome,
  type BackendPort,
  type Grants,
} from "../../engine/contracts/index.ts";
import { surfaceFixture } from "./rewrite-surface-fixture.ts";

test(
  "bound child requests reject spoofed authority and out-of-subtree origins without changing accepted state",
  { timeout: 15_000 },
  async (t) => {
    const grants: Grants = {
      access: "write",
      tools: ["read", "write"],
      workspaces: ["shared"],
      inheritContext: false,
      memory: { scope: "none", access: "read" },
      delegation: { maxDepth: 2, agents: ["fixture"], tools: ["read"], workspaces: ["shared"] },
    };
    const backend: BackendPort = {
      kind: "in-process",
      capabilities: {
        available: true,
        steer: true,
        continuation: false,
        conversationSeed: false,
        surviving: false,
        cleanup: "confirmed",
        delegation: true,
      },
      async start(launch, observe) {
        const identity = {
          id: launch.attemptId,
          kind: "in-process" as const,
          ownerEpoch: launch.ownerEpoch,
        };
        const artifact = await launch.artifacts.put(
          Buffer.from("Held scripted child-authority fixture"),
        );
        await observe({ kind: "enrolled", identity, evidence: [artifact] });
        for (const message of launch.initialMessages)
          await observe({ kind: "input_consumed", messageId: message.id, checkpoint: artifact });
        let finish: (outcome: BackendOutcome) => void = () => {};
        const done = new Promise<BackendOutcome>((resolve) => {
          finish = resolve;
        });
        return {
          identity,
          done,
          input: async () => ({ status: "undelivered" }),
          checkpoint: async () => ({
            format: "scripted",
            worker: launch.ref.worker,
            id: launch.attemptId,
            branch: "fixture",
            artifact,
          }),
          async stop() {
            finish({
              reason: "cancelled",
              summary: "Fixture stopped",
              artifacts: [],
              usage: { expectedAttempts: [launch.attemptId], observations: [], complete: false },
            });
            return {
              cleanup: {
                status: "stopped",
                ownerEpoch: launch.ownerEpoch,
                identities: [identity.id],
                evidence: [artifact],
              },
            };
          },
        };
      },
    };
    const f = await surfaceFixture(t, { execution: true, backend, grants });
    assert.equal(
      (
        await f.runtime.execute(
          {
            requestId: "create",
            command: {
              kind: "create",
              workers: ["parent", "sibling"].map((id) => ({ id, agent: "fixture", task: "Hold" })),
            },
          },
          f.caller,
        )
      ).status,
      "accepted",
    );
    const ref = (worker: string) => ({ run: f.run, worker, assignment: 1 });
    const running = async (worker: string) => {
      while (
        f.control.snapshot().snapshot.assignments[assignmentKey(ref(worker))]?.execution.phase !==
        "running"
      )
        await setTimeout(1);
    };
    await Promise.all([running("parent"), running("sibling")]);
    const port = f.runtime.bindChild(ref("parent"));
    const command = { kind: "add", workers: [{ id: "child", agent: "fixture", task: "Hold" }] };
    const before = await f.runtime.query({ kind: "status" }, f.caller);
    for (const [index, spoof] of [
      { parentAssignment: ref("sibling") },
      { run: "another-run" },
      { caller: { ...f.caller, parentAssignment: ref("sibling") } },
      { grants },
    ].entries()) {
      await assert.rejects(port.execute({ requestId: `spoof-${index}`, command, ...spoof }));
      assert.deepEqual(await f.runtime.query({ kind: "status" }, f.caller), before);
    }
    await assert.rejects(
      port.execute({
        requestId: "worker-spoof",
        command: {
          kind: "add",
          workers: [{ ...command.workers[0], parentAssignment: ref("sibling") }],
        },
      }),
    );
    await assert.rejects(
      port.execute({
        requestId: "cross-run-origin",
        command: {
          kind: "add",
          workers: [{ ...command.workers[0], origin: { ...ref("parent"), run: "another-run" } }],
        },
      }),
    );
    assert.deepEqual(await f.runtime.query({ kind: "status" }, f.caller), before);
    const outside = await port.execute({
      requestId: "outside-origin",
      command: {
        kind: "add",
        workers: [{ ...command.workers[0], origin: { worker: "sibling", assignment: 1 } }],
      },
    });
    assert.equal(outside.status, "rejected");
    if (outside.status !== "rejected") throw new Error("Expected subtree rejection");
    assert.equal(outside.error.code, "capability_denied");
    assert.deepEqual(await f.runtime.query({ kind: "status" }, f.caller), before);
    const accepted = await port.execute({
      requestId: "authorized-origin",
      command: {
        kind: "add",
        workers: [{ ...command.workers[0], origin: { worker: "parent", assignment: 1 } }],
      },
    });
    assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
    await running("child");
    const status = await f.runtime.query({ kind: "status" }, f.caller);
    assert(status.kind === "status");
    assert.deepEqual(status.state.workers.child.origin, ref("parent"));
    assert.deepEqual(status.state.workers.child.parentAssignment, ref("parent"));
    assert.deepEqual(status.state.workers.child.tools, ["read"]);
  },
);
