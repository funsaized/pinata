import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { applicationFixture } from "./rewrite-application-fixture.ts";
import type { FaultHook } from "../../engine/storage/io.ts";

const ref = { run: "application-fixture", worker: "worker", assignment: 1 };

async function fixture(t: TestContext, fault?: FaultHook) {
  const f = await applicationFixture(fault);
  const worktree = await f.worktree();
  t.after(async () => {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  return { ...f, worktree };
}

test("explicit application selects current worktree edits and supports repeat applications without new assignments", async (t) => {
  const f = await fixture(t);
  const index = await readFile(join(f.repo.gitDirectory, "index"));
  await writeFile(join(f.root, "unrelated.txt"), "user edit\n");
  await writeFile(join(f.worktree.path, "file.txt"), "first\n");
  await writeFile(join(f.worktree.path, "new.txt"), "untracked\n");
  const first = await f.store.applyWorktree({ ref, worktree: f.worktree, operationId: "first" });
  assert.equal(first.snapshot, undefined);
  assert(first.tree);
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "untracked\n");
  await writeFile(join(f.worktree.path, "file.txt"), "second\n");
  await f.git.run(f.worktree.path, ["add", "file.txt", "new.txt"]);
  await f.git.run(f.worktree.path, ["commit", "-qm", "Manual isolated commit"]);
  const head = (await f.git.run(f.worktree.path, ["rev-parse", "HEAD"])).stdout.toString();
  const repeated = await f.store.applyWorktree({ ref, worktree: f.worktree, operationId: "first" });
  assert.equal(repeated.status, "already_recorded");
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "first\n");
  const second = await f.store.applyWorktree({ ref, worktree: f.worktree, operationId: "second" });
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "second\n");
  assert.notEqual(first.tree, second.tree);
  await f.store.rollback(second.operationId);
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "first\n");
  await f.store.applyWorktree({ ref, worktree: f.worktree });
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "second\n");
  assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "user edit\n");
  assert.deepEqual(await readFile(join(f.repo.gitDirectory, "index")), index);
  assert.equal(
    (await f.git.run(f.root, ["rev-parse", "HEAD"])).stdout.toString().trim(),
    f.repo.head,
  );
  assert.equal((await f.git.run(f.worktree.path, ["rev-parse", "HEAD"])).stdout.toString(), head);
  assert(
    (await f.store.inspect()).operations.every(
      (operation) => !operation.snapshot && operation.worktree,
    ),
  );
});

test("worktree application and rollback refuse conflicting user edits", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.worktree.path, "file.txt"), "worker edit\n");
  await writeFile(join(f.root, "file.txt"), "user edit\n");
  await assert.rejects(f.store.applyWorktree({ ref, worktree: f.worktree }), /conflicting changes/);
  assert.equal((await f.store.inspect()).operations.length, 0);
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "user edit\n");
  await writeFile(join(f.root, "file.txt"), "base\n");
  const receipt = await f.store.applyWorktree({ ref, worktree: f.worktree });
  await writeFile(join(f.root, "file.txt"), "later user edit\n");
  await assert.rejects(f.store.rollback(receipt.operationId), /later edits/);
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "later user edit\n");
});

test("worktree handoff uses current edits without creating checkout gates", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.worktree.path, "file.txt"), "handoff output\n");
  assert.equal((await f.store.applyWorktree({ ref, worktree: f.worktree })).status, "applied");
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "handoff output\n");
  for (const root of [f.root, f.worktree.path])
    await assert.rejects(readFile(join(root, ".pinata", "checkout-gate", "manifest.json")), {
      code: "ENOENT",
    });
});

test("worktree identity and frozen destination cannot be substituted", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.store.applyWorktree({ ref, worktree: { ...f.worktree, path: f.root } }),
    /accepted plan/,
  );
  await assert.rejects(
    f.store.applyWorktree({ ref: { ...ref, worker: "other" }, worktree: f.worktree }),
    /accepted plan/,
  );
  await assert.rejects(
    f.store.applyWorktree({ ref, worktree: { ...f.worktree, gitDirectory: f.repo.gitDirectory } }),
    /Git identity/,
  );
  assert.equal((await f.store.inspect()).operations.length, 0);
});

test("worktree application recovers selected bytes after the source is removed", async (t) => {
  let fail = true;
  const f = await fixture(t, (point) => {
    if (fail && point === "application.file.file.txt.rename.after") {
      fail = false;
      throw new Error("Interrupted file application");
    }
  });
  await writeFile(join(f.worktree.path, "file.txt"), "selected bytes\n");
  await writeFile(join(f.worktree.path, "new.txt"), "selected addition\n");
  await assert.rejects(
    f.store.applyWorktree({ ref, worktree: f.worktree, operationId: "recover" }),
    /Interrupted/,
  );
  await f.store.close();
  await rm(f.worktree.path, { recursive: true });
  const recovered = await f.reopen();
  try {
    assert.equal((await recovered.reconcile())?.status, "applied");
    assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "selected bytes\n");
    assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "selected addition\n");
    assert.equal(
      (await recovered.applyWorktree({ ref, worktree: f.worktree, operationId: "recover" })).status,
      "already_recorded",
    );
    await recovered.rollback("recover");
    assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "base\n");
  } finally {
    await recovered.close();
  }
});

test("an unpublished worktree selection can retry the same operation without changing destination files", async (t) => {
  let fail = true;
  const f = await fixture(t, (point) => {
    if (fail && point === "application.journal.intent.write.before") {
      fail = false;
      throw new Error("Interrupted before journal");
    }
  });
  await writeFile(join(f.worktree.path, "file.txt"), "first selection\n");
  await assert.rejects(
    f.store.applyWorktree({ ref, worktree: f.worktree, operationId: "retry" }),
    /Interrupted/,
  );
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "base\n");
  await f.store.close();
  const recovered = await f.reopen();
  try {
    assert.equal(await recovered.reconcile(), null);
    await writeFile(join(f.worktree.path, "file.txt"), "new selection\n");
    await recovered.applyWorktree({ ref, worktree: f.worktree, operationId: "retry" });
    assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "new selection\n");
  } finally {
    await recovered.close();
  }
});
