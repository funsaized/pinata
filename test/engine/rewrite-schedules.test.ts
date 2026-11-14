import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assignmentKey,
  grantsSchema,
  schemaRegistry,
  transitionArtifacts,
  transitionSchema,
  type CallerAuthority,
} from "../../engine/contracts/index.ts";
import { initialState, reduce } from "../../engine/core/state.ts";
import { Runtime } from "../../engine/runtime/index.ts";
import { DurableStore } from "../../engine/storage/index.ts";
import { openSavedSource } from "../../engine/sources/saved.ts";

async function legacyFixture() {
  const saved = JSON.parse(
    await readFile(new URL("./fixtures/legacy-schedules.json", import.meta.url), "utf8"),
  );
  return {
    run: String(saved.run),
    definition: String(saved.definition),
    grants: grantsSchema.parse(saved.grants),
    transitions: transitionSchema.array().parse(saved.transitions),
  };
}

test("historical active schedules replay accepted FIFO work and receipts without generating new occurrences", async (t) => {
  const legacy = await legacyFixture();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-legacy-schedule-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await DurableStore.open({
    directory,
    manifest: {
      schemaVersion: 1,
      run: legacy.run,
      workspace: directory,
      store: directory,
      createdAt: "2026-11-08T00:00:00.000Z",
    },
  });
  await store.putArtifact(Buffer.from(legacy.definition));
  let expected = initialState(legacy.run);
  for (const transition of legacy.transitions) {
    assert("requestId" in transition && "payloadDigest" in transition);
    await store.append({
      requestId: transition.requestId,
      payloadDigest: transition.payloadDigest,
      transition,
      artifacts: transitionArtifacts(transition),
    });
    expected = reduce(expected, transition, expected.revision + 1);
  }
  await store.close();
  const caller: CallerAuthority = {
    id: "coordinator",
    kind: "coordinator",
    run: legacy.run,
    grants: legacy.grants,
  };
  const first = { run: legacy.run, worker: "daily-worker", assignment: 1 };
  const second = { ...first, assignment: 2 };
  assert.equal(expected.schedules.daily.status, "active");
  assert.equal(expected.latest[first.worker], 2);
  assert.deepEqual(expected.assignments[assignmentKey(second)].after, [first]);
  for (let reopen = 0; reopen < 2; reopen++) {
    const runtime = await Runtime.open({ directory });
    try {
      assert.deepEqual(await runtime.query({ kind: "status" }, caller), {
        kind: "status",
        state: expected,
      });
      for (const transition of legacy.transitions) {
        assert("requestId" in transition);
        assert.deepEqual(
          await runtime.query({ kind: "receipt", requestId: transition.requestId }, caller),
          { kind: "receipt", receipt: expected.receipts[transition.requestId].receipt },
        );
      }
      for (const action of ["create", "resume", "list"]) {
        const receipt = await runtime.execute(
          {
            requestId: `removed/${action}`,
            command: { kind: "schedule", schedule: { action, id: "daily" } },
          },
          caller,
        );
        assert.equal(receipt.status, "rejected");
      }
      assert.equal("scheduleTick" in runtime, false);
      assert.deepEqual(await runtime.query({ kind: "status" }, caller), {
        kind: "status",
        state: expected,
      });
      const saved = await openSavedSource(directory);
      assert.deepEqual(saved.snapshot().snapshot, expected);
    } finally {
      await runtime.close();
    }
  }
  assert.equal(
    Object.keys(schemaRegistry).some((name) => /pinata\.(schedule|job|ipc)/.test(name)),
    false,
  );
});

test("legacy occurrence replay still rejects mismatched acceptance and receipt evidence", async () => {
  const fixture = await legacyFixture();
  let state = initialState(fixture.run);
  for (const transition of fixture.transitions) {
    if (transition.kind === "schedule_occurrence" && transition.acceptance) {
      const corrupted = structuredClone(transition);
      assert(corrupted.acceptance);
      corrupted.acceptance.assignments[0].task = "Changed historical task";
      assert.throws(() => reduce(state, corrupted, state.revision + 1), /acceptance differ/);
    }
    state = reduce(state, transition, state.revision + 1);
  }
});
