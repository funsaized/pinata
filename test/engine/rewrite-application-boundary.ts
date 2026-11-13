import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applicationFixture } from "./rewrite-application-fixture.ts";
import { openCheckoutGate } from "../../engine/workspace/gate.ts";

export async function applicationBoundaryRecovery(direction: "apply" | "rollback"): Promise<void> {
  const observed = new Set<string>();
  const tracing = await applicationFixture((point) => {
    observed.add(point);
  });
  const ref = { run: "application-fixture", worker: "worker", assignment: 1 };
  const edit = async (path: string) => {
    await rm(join(path, "file.txt"));
    await mkdir(join(path, "nested"));
    await writeFile(join(path, "nested/new.txt"), "new nested bytes\n");
    if (process.platform !== "win32") await chmod(join(path, "unrelated.txt"), 0o755);
  };
  try {
    const worktree = await tracing.worktree();
    await edit(worktree.path);
    const receipt = await tracing.store.applyWorktree({ ref, worktree });
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
      const worktree = await fixture.worktree();
      await edit(worktree.path);
      let applied;
      if (direction === "rollback") applied = await fixture.store.applyWorktree({ ref, worktree });
      enabled = true;
      await assert.rejects(
        direction === "apply"
          ? fixture.store.applyWorktree({ ref, worktree })
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
        const receipt = await recovered.applyWorktree({ ref, worktree });
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
        await recovered.applyWorktree({ ref, worktree });
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
