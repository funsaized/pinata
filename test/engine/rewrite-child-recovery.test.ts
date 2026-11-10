import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { coreStateSchema, digestValue } from "../../engine/contracts/index.ts";
import { Runtime } from "../../engine/runtime/index.ts";
import { readOwner } from "../../engine/storage/owner.ts";
import { reconcileStore } from "../../engine/storage/reconcile.ts";
import { occupiedAssignments } from "../../engine/core/readiness.ts";
import { processEnrollmentSchema, readRecord } from "../../engine/backends/process-transport.ts";
import {
  observeProcess,
  reconcileSupervisor,
  stopSupervisor,
  type SupervisorIdentity,
} from "../../engine/backends/supervision/index.ts";
import { openChildRecoveryHost } from "./fixtures/rewrite-child-owner.ts";

async function until(predicate: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await delay(20);
  }
}

for (const lifetime of ["attached", "surviving"] as const)
  test(
    `nested ${lifetime} processes preserve exact attempts and clean up after real root owner loss`,
    { skip: !["linux", "darwin"].includes(process.platform), timeout: 90_000 },
    async (t) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-child-recovery-")));
      const store = join(directory, "run");
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./fixtures/rewrite-child-owner.ts", import.meta.url)),
          directory,
          lifetime,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let ready = false;
      let errors = "";
      child.on("message", (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "phase" in message &&
          message.phase === "ready"
        )
          ready = true;
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        errors += chunk;
      });
      const exited = once(child, "exit");
      const supervisors: SupervisorIdentity[] = [];
      let verified = false;
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        // A failed readiness barrier can still leave a surviving worker enrolled.
        // Recover this fixture's exact identities before cleaning up the test.
        const workers = await readdir(join(store, "workers")).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
          throw error;
        });
        for (const worker of workers) {
          const enrollment = await readRecord(
            join(store, "workers", worker, "enrollment.json"),
            processEnrollmentSchema,
          );
          if (enrollment && !supervisors.some((entry) => entry.id === enrollment.supervisor.id))
            supervisors.push(enrollment.supervisor);
        }
        for (const identity of supervisors)
          await stopSupervisor(identity, { graceMs: 50, confirmationMs: 1000 });
        if (verified) await rm(directory, { recursive: true, force: true });
        else t.diagnostic(`Retained nested owner-loss evidence at ${directory}`);
      });
      await until(async () => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Nested owner exited before readiness: ${errors}`);
        return ready;
      }, "parent and child running behind provider barrier");
      const before = coreStateSchema.parse(
        JSON.parse(await readFile(join(directory, "ready.json"), "utf8")),
      );
      assert.deepEqual(Object.keys(before.workers).sort(), ["leaf", "parent"]);
      assert.equal(before.workers.leaf.parentAssignment?.worker, "parent");
      assert.equal(before.workers.leaf.lifetime, lifetime);
      assert.equal(occupiedAssignments(before).length, 2);
      const attemptIds = Object.keys(before.attempts).sort();
      assert.equal(attemptIds.length, 2);
      const owner = await readOwner(store);
      assert(owner);
      assert.equal(owner.pid, child.pid);
      for (const entry of Object.values(before.attempts)) {
        const enrollment = await readRecord(
          join(store, "workers", digestValue(entry.attempt.id), "enrollment.json"),
          processEnrollmentSchema,
        );
        assert(enrollment);
        assert.equal(enrollment.supervisor.ownerEpoch, owner.epoch);
        supervisors.push(enrollment.supervisor);
      }
      const payloads = await Promise.all(
        ["parent", "leaf"].map(async (name) => {
          const pid = Number(
            await readFile(join(directory, "agent", `orphan-${name}-ready`), "utf8"),
          );
          assert(Number.isSafeInteger(pid) && pid > 0);
          const identity = await observeProcess(pid);
          assert(identity);
          return identity;
        }),
      );
      const journalBefore = await readFile(join(store, "journal.jsonl"));
      const ownedProcesses = [...payloads, ...supervisors.map((identity) => identity.process)];
      child.kill("SIGKILL");
      const [, signal] = await exited;
      assert.equal(signal, "SIGKILL", errors);
      await assert.rejects(Runtime.open({ directory: store }), /owner|claim/i);
      const reconciliation = await reconcileStore({
        directory: store,
        expectedOwnerToken: owner.token,
        reason: `The scripted root was killed while its ${lifetime} parent and child were active`,
      });
      const retained = JSON.parse(
        await readFile(join(reconciliation.evidenceDirectory, "reconciliation.json"), "utf8"),
      );
      assert.equal(retained.owner.token, owner.token);
      const stopped = async () => {
        const observations = await Promise.all(
          ownedProcesses.map((identity) => observeProcess(identity.pid)),
        );
        return observations.every(
          (current, index) =>
            !current ||
            current.state.startsWith("Z") ||
            current.startIdentity !== ownedProcesses[index].startIdentity,
        );
      };
      if (lifetime === "attached") {
        await until(stopped, "attached parent and child stopped after root loss");
        for (const identity of supervisors)
          assert.equal(
            (
              await reconcileSupervisor(identity, {
                reason: "Inspect nested attached cleanup after root death",
              })
            ).status,
            "stopped",
          );
      } else {
        for (const identity of payloads) {
          const current = await observeProcess(identity.pid);
          assert.equal(current?.startIdentity, identity.startIdentity);
          assert(current && !current.state.startsWith("Z"));
        }
      }
      const reopened = await openChildRecoveryHost(directory);
      t.after(() => reopened.close("Recovery fixture teardown"));
      const initial = await reopened.runtime.query({ kind: "status" }, reopened.caller);
      assert(initial.kind === "status");
      assert.deepEqual(Object.keys(initial.state.attempts).sort(), attemptIds);
      assert.equal(occupiedAssignments(initial.state).length, 2);
      const recovery = await reopened.runtime.recover({}, reopened.caller);
      assert.equal(recovery.length, 2);
      if (lifetime === "surviving") {
        assert(
          recovery.every((receipt) => receipt.status === "reattached"),
          JSON.stringify(recovery),
        );
        const cancelled = await reopened.runtime.execute(
          {
            requestId: "stop-recovered-subtree",
            command: { kind: "cancel", scope: "worker", worker: "parent" },
          },
          reopened.caller,
        );
        assert.equal(cancelled.status, "accepted");
        const completed = await reopened.runtime.wait(
          {},
          reopened.caller,
          AbortSignal.timeout(30_000),
        );
        assert.equal(completed.status, "settled", JSON.stringify(reopened.runtime.diagnostics()));
        assert.equal(completed.results.length, 2);
        for (const result of completed.results)
          assert.deepEqual(result.execution, {
            phase: "ended",
            reason: "cancelled",
            cleanup: "confirmed",
          });
        assert.equal((await reopened.close("Recovered subtree stopped")).status, "closed");
        await until(stopped, "recovered surviving parent and child stopped");
      } else {
        // Guardian cleanup proves no orphan survives, but cannot invent the
        // worker's missing terminal outcome or silently release its run slot.
        assert(
          recovery.every((receipt) => receipt.status === "uncertain"),
          JSON.stringify(recovery),
        );
        assert.equal(
          (await reopened.close("Preserve missing terminal outcome evidence")).status,
          "owner_unconfirmed",
        );
      }
      const after = await reopened.runtime.query({ kind: "status" }, reopened.caller);
      assert(after.kind === "status");
      assert.deepEqual(Object.keys(after.state.attempts).sort(), attemptIds);
      assert.deepEqual(after.state.latest, before.latest);
      assert.equal(after.state.workers.leaf.parentAssignment?.worker, "parent");
      assert(
        (await readFile(join(store, "journal.jsonl")))
          .subarray(0, journalBefore.length)
          .equals(journalBefore),
      );
      if (lifetime === "surviving") {
        assert.equal(occupiedAssignments(after.state).length, 0);
        for (const entry of Object.values(after.state.attempts)) {
          assert.equal(entry.cleanup?.status, "stopped");
          assert.equal(entry.cleanup?.ownerEpoch, owner.epoch);
        }
      } else {
        assert.equal(occupiedAssignments(after.state).length, 2);
        assert.equal(Object.keys(after.state.results).length, 0);
        assert(await readOwner(store));
      }
      verified = true;
    },
  );
