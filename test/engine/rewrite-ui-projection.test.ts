import assert from "node:assert/strict";
import test from "node:test";
import { assignmentKey, type RuntimeEvent, type Transition } from "../../engine/contracts/index.ts";
import { reduce } from "../../engine/core/state.ts";
import { ScreenRouter } from "../../engine/ui/router.ts";
import { UiSource } from "./rewrite-ui-fixture.ts";

class CountedSource extends UiSource {
  reads = 0;
  override snapshot() {
    this.reads++;
    return super.snapshot();
  }
  commit(transition: Transition): Extract<RuntimeEvent, { kind: "committed" }> {
    this.state = reduce(this.state, transition, this.state.revision + 1);
    return {
      schemaVersion: 1,
      kind: "committed",
      id: `commit/${this.state.revision}`,
      ownerEpoch: this.epoch,
      revision: this.state.revision,
      transition,
    };
  }
}

test("UI projects ordered commits without snapshot reads or observing future source state", async (t) => {
  const source = new CountedSource();
  const router = new ScreenRouter(source);
  t.after(() => router.dispose());
  await router.start();
  const reads = source.reads;
  const workers = router.state.workers;
  const first = source.commit({ kind: "capacity_changed", maxConcurrent: 1 });
  const second = source.commit({ kind: "capacity_changed", maxConcurrent: 2 });
  await source.emit(first);
  assert.equal(router.state.revision, 1);
  assert.equal(router.state.maxConcurrent, 1);
  assert.equal(router.state.workers, workers, "Unchanged state remains shared within the view");
  await source.emit(second);
  assert.deepEqual(router.state, source.state);
  assert.equal(source.reads, reads);
  await source.emit(first);
  await source.emit(second);
  assert.deepEqual(router.state, source.state, "Repeated commits cannot roll the view back");
  assert.equal(source.reads, reads);
});

test("UI consumes snapshot payloads and resynchronizes gaps without losing local drafts", async (t) => {
  const source = new CountedSource();
  let now = 0;
  const router = new ScreenRouter(source, { now: () => now });
  t.after(() => router.dispose());
  await router.start();
  router.navigate("fleet");
  router.setDraft("Keep my unsent instructions");
  const selected = router.selected;
  assert(selected);
  await source.emit(
    source.commit({ kind: "assignment_state", ref: selected, execution: { phase: "preparing" } }),
  );
  now = 100;
  assert.equal(router.observedElapsed(selected), 100);
  source.commit({ kind: "capacity_changed", maxConcurrent: 1 });
  const afterGap = source.commit({ kind: "capacity_changed", maxConcurrent: 2 });
  const reads = source.reads;
  await source.emit(afterGap);
  assert.equal(source.reads, reads + 1);
  assert.deepEqual(router.state, source.state);
  assert.deepEqual(router.selected, selected);
  assert.equal(router.draft, "Keep my unsent instructions");
  assert.equal(router.observedElapsed(selected), undefined, "A gap cannot supply elapsed evidence");
  const reset = source.snapshot();
  const beforeReset = source.reads;
  await source.emit(reset);
  assert.equal(source.reads, beforeReset, "A reset already carries its complete state");
  assert.deepEqual(router.state, source.state);
});

test("UI resynchronizes a new owner and keeps activity separate from committed state", async (t) => {
  const source = new CountedSource();
  const router = new ScreenRouter(source, { mode: "observe" });
  t.after(() => router.dispose());
  await router.start();
  const selected = router.selected;
  assert(selected);
  await source.activity(1, 1, "old owner");
  source.epoch = "epoch-two";
  const event = source.commit({ kind: "capacity_changed", maxConcurrent: 2 });
  const reads = source.reads;
  await source.emit(event);
  assert.equal(source.reads, reads + 1);
  assert.deepEqual(router.state, source.state);
  assert.equal(router.activity.size, 0);
  const state = router.state;
  await source.activity(1, 1, "new owner");
  assert.equal(router.activity.get(assignmentKey(selected)), "new owner");
  assert.equal(router.state, state);
  assert.equal(source.reads, reads + 1);
});

test("UI ignores stale snapshots and clears elapsed evidence across snapshot resets", async (t) => {
  const source = new CountedSource();
  let now = 0;
  const router = new ScreenRouter(source, { now: () => now });
  t.after(() => router.dispose());
  await router.start();
  const stale = source.snapshot();
  const selected = router.selected;
  assert(selected);
  await source.emit(
    source.commit({ kind: "assignment_state", ref: selected, execution: { phase: "preparing" } }),
  );
  now = 100;
  await source.emit(stale);
  assert.equal(router.state.revision, 1);
  assert.equal(router.observedElapsed(selected), 100);
  await source.emit(source.snapshot());
  assert.equal(router.observedElapsed(selected), 100, "An unchanged snapshot retains timing");
  source.commit({ kind: "capacity_changed", maxConcurrent: 2 });
  const reset = source.snapshot();
  const reads = source.reads;
  await source.emit(reset);
  assert.deepEqual(router.state, source.state);
  assert.equal(source.reads, reads);
  assert.equal(router.observedElapsed(selected), undefined);
});

test("UI replaces coalesced activity snapshots and ignores their replay", async (t) => {
  const source = new CountedSource();
  const router = new ScreenRouter(source, { mode: "observe" });
  t.after(() => router.dispose());
  await router.start();
  const ref = router.selected;
  assert(ref);
  await source.activity(1, 1, "older text");
  const event: RuntimeEvent = {
    schemaVersion: 1,
    kind: "activity",
    source: "stream-1",
    ordinal: 10,
    ownerEpoch: source.epoch,
    revision: source.state.revision,
    ref,
    text: "current tail",
    snapshot: true,
  };
  await source.emit(event);
  await source.emit(event);
  assert.equal(router.activity.get(assignmentKey(ref)), "current tail");
  await source.activity(1, 11, " plus delta");
  assert.equal(router.activity.get(assignmentKey(ref)), "current tail plus delta");
});
