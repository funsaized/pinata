import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { applicationFixture } from "./rewrite-application-fixture.ts";
import { openCheckoutGate } from "../../engine/workspace/gate.ts";

export async function applicationBoundaryRecovery(direction: "apply" | "rollback"): Promise<void> {
  const observed = new Set<string>();
  const tracing = await applicationFixture((point) => {
    observed.add(point);
  });
  const entries = [
    { path: "nested/new.txt", content: "new nested bytes\n" },
    {
      path: "unrelated.txt",
      content: "untouched\n",
      mode: process.platform === "win32" ? ("100644" as const) : ("100755" as const),
    },
  ];
  try {
    const snapshot = await tracing.snapshot(1, entries);
    const receipt = await tracing.store.apply({ snapshot });
    if (direction === "rollback") {
      observed.clear();
      await tracing.store.rollback(receipt.operationId);
    }
  } finally {
    await tracing.store.close();
    await rm(tracing.directory, { recursive: true, force: true });
  }
  assert(observed.has("application.journal.terminal.rename.after"));
  assert(
    [...observed].some(
      (point) => point.endsWith("rename.after") && point.startsWith("application.file."),
    ),
  );
  for (const boundary of observed) {
    let enabled = false;
    let triggered = false;
    const fixture = await applicationFixture((point) => {
      if (enabled && point === boundary) {
        triggered = true;
        throw new Error(`Injected ${boundary}`);
      }
    });
    try {
      const index = await readFile(join(fixture.repo.gitDirectory, "index"));
      const snapshot = await fixture.snapshot(1, entries);
      let applied;
      if (direction === "rollback") applied = await fixture.store.apply({ snapshot });
      enabled = true;
      await assert.rejects(
        direction === "apply"
          ? fixture.store.apply({ snapshot })
          : fixture.store.rollback(applied?.operationId ?? "missing"),
        /Injected/,
        boundary,
      );
      assert.equal(triggered, true, boundary);
      enabled = false;
      const recovered = await fixture.reopen();
      await recovered.reconcile();
      const journal = await recovered.inspect();
      if (direction === "apply") {
        const receipt = await recovered.apply({ snapshot });
        assert(["applied", "already_recorded"].includes(receipt.status), boundary);
        assert.equal(
          await readFile(join(fixture.root, "nested/new.txt"), "utf8"),
          "new nested bytes\n",
          boundary,
        );
        await assert.rejects(readFile(join(fixture.root, "file.txt")), { code: "ENOENT" });
        assert.equal(
          Object.values((await recovered.inspect()).cursors)[0].ref.assignment,
          1,
          boundary,
        );
      } else {
        if (journal.operations.at(-1)?.phase === "applied")
          await recovered.rollback(journal.operations.at(-1)?.id ?? "missing");
        assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n", boundary);
        assert.deepEqual((await recovered.inspect()).cursors, {}, boundary);
        await recovered.apply({ snapshot });
        assert.equal(
          await readFile(join(fixture.root, "nested/new.txt"), "utf8"),
          "new nested bytes\n",
          boundary,
        );
      }
      assert.deepEqual(await readFile(join(fixture.repo.gitDirectory, "index")), index, boundary);
      assert.equal(
        (await (await openCheckoutGate(fixture.root)).inspect()).exclusive,
        undefined,
        boundary,
      );
      await recovered.close();
    } finally {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
}
