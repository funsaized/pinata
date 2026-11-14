import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { applicationFixture, FixtureArtifacts, FixtureGit } from "./rewrite-application-fixture.ts";
import { ApplicationLock } from "../../engine/application/lock.ts";
import { ApplicationStore } from "../../engine/application/index.ts";

const after = (content: string) => [
  { path: "file.txt", content },
  { path: "unrelated.txt", content: "untouched\n" },
];

test(
  "application history and rollback survive different run artifact stores",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await applicationFixture();
    let next: ApplicationStore | undefined;
    t.after(async () => {
      await next?.close();
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const firstWorktree = await fixture.worktree();
    const secondWorktree = await fixture.worktree();
    const secondArtifacts = new FixtureArtifacts(join(fixture.directory, "second-run-artifacts"));
    const plan = JSON.parse(
      Buffer.from(await fixture.artifacts.read(secondWorktree.plan)).toString("utf8"),
    );
    secondWorktree.plan = await secondArtifacts.put(
      Buffer.from(JSON.stringify({ ...plan, run: "second-run", worker: "second" })),
    );
    await writeFile(join(firstWorktree.path, "file.txt"), "first run\n");
    await writeFile(join(secondWorktree.path, "unrelated.txt"), "second run\n");
    const index = await readFile(join(fixture.repo.gitDirectory, "index"));
    const first = await fixture.store.applyWorktree({
      ref: { run: "application-fixture", worker: "worker", assignment: 1 },
      worktree: firstWorktree,
    });
    await fixture.store.close();
    await rm(fixture.artifacts.directory, { recursive: true });
    next = await ApplicationStore.open({
      ...fixture.applicationOptions,
      artifacts: secondArtifacts,
    });
    assert.equal((await next.inspect()).operations.length, 1);
    await next.rollback(first.operationId);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
    const second = await next.applyWorktree({
      ref: { run: "second-run", worker: "second", assignment: 1 },
      worktree: secondWorktree,
    });
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(fixture.root, "unrelated.txt"), "utf8"), "second run\n");
    await next.rollback(second.operationId);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(fixture.root, "unrelated.txt"), "utf8"), "untouched\n");
    assert.deepEqual((await next.inspect()).cursors, {});
    assert.deepEqual(await readFile(join(fixture.repo.gitDirectory, "index")), index);
  },
);

test(
  "a later run reconciles an interrupted application without the source run or worktree",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await applicationFixture((point) => {
      if (point === "application.file.file.txt.rename.before") throw new Error("Interrupted apply");
    });
    let next: ApplicationStore | undefined;
    t.after(async () => {
      await next?.close();
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const worktree = await fixture.worktree();
    await writeFile(join(worktree.path, "file.txt"), "recover from checkout evidence\n");
    await assert.rejects(
      fixture.store.applyWorktree({
        ref: { run: "application-fixture", worker: "worker", assignment: 1 },
        worktree,
      }),
      /Interrupted apply/,
    );
    await fixture.store.close();
    await rm(fixture.artifacts.directory, { recursive: true });
    await rm(worktree.path, { recursive: true });
    next = await ApplicationStore.open({
      ...fixture.applicationOptions,
      artifacts: new FixtureArtifacts(join(fixture.directory, "recovery-run-artifacts")),
    });
    const receipt = await next.reconcile();
    assert.equal(receipt?.status, "applied");
    assert.equal(
      await readFile(join(fixture.root, "file.txt"), "utf8"),
      "recover from checkout evidence\n",
    );
    assert.equal((await next.inspect()).operations.at(-1)?.phase, "applied");
  },
);

test(
  "legacy application blobs migrate from the original run and corrupt retained blobs fail closed",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await applicationFixture();
    let next: ApplicationStore | undefined;
    t.after(async () => {
      await next?.close();
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const snapshot = await fixture.snapshot(1, after("legacy bytes\n"));
    const receipt = await fixture.store.apply({ snapshot });
    const retained = join(fixture.store.directory, "artifacts");
    await rm(retained, { recursive: true });
    const secondArtifacts = new FixtureArtifacts(join(fixture.directory, "second-run-artifacts"));
    next = await ApplicationStore.open({
      ...fixture.applicationOptions,
      artifacts: secondArtifacts,
    });
    await assert.rejects(next.inspect(), /Reopen the originating run/);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "legacy bytes\n");
    const journal = await fixture.store.inspect();
    const changed = journal.operations[0].changes.find((change) => change.after)?.after;
    assert(changed);
    const path = join(retained, changed.blob.digest);
    const original = await readFile(path);
    await writeFile(path, "corrupt retained blob");
    await assert.rejects(fixture.store.inspect(), /Application artifact is corrupt/);
    await writeFile(path, original);
    await rm(fixture.artifacts.directory, { recursive: true });
    assert.equal((await next.inspect()).operations.length, 1);
    await next.rollback(receipt.operationId);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
  },
);

test(
  "application refuses FIFO destinations without waiting for a writer",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const fixture = await applicationFixture();
    t.after(async () => {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    await rm(join(fixture.root, "file.txt"));
    await promisify(execFile)("mkfifo", [join(fixture.root, "file.txt")]);
    const source = new URL("../../engine/application/files.ts", import.meta.url).href;
    // A separate process bounds a regressed blocking open, which cannot be
    // interrupted by an AbortSignal or the Node test timeout.
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict';
         import { readApplicationFile } from ${JSON.stringify(source)};
         await assert.rejects(readApplicationFile(process.argv[1], 'file.txt'), /not a regular file/);`,
        fixture.root,
      ],
      { timeout: 5000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
    );
    assert.equal((await fixture.store.inspect()).operations.length, 0);
  },
);

test(
  "application preserves index and unrelated edits, rolls back and incrementally reapplies immutable snapshots",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await applicationFixture();
    t.after(async () => {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const index = await readFile(join(fixture.repo.gitDirectory, "index"));
    const first = await fixture.snapshot(1, after("first\n"));
    const second = await fixture.snapshot(2, after("second\n"));
    await writeFile(join(fixture.root, "unrelated.txt"), "user edit\n");
    const applied = await fixture.store.apply({ snapshot: first });
    assert.equal(applied.status, "applied");
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "first\n");
    const repeated = await fixture.store.apply({ snapshot: first });
    assert.equal(repeated.status, "already_recorded");
    assert.equal(repeated.operationId, applied.operationId);
    const rolledBack = await fixture.store.rollback(applied.operationId);
    assert.equal(rolledBack.status, "rolled_back");
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
    assert.deepEqual((await fixture.store.inspect()).cursors, {});
    const reapplied = await fixture.store.apply({ snapshot: first });
    assert.equal(reapplied.status, "applied");
    assert.notEqual(reapplied.operationId, applied.operationId);
    const advanced = await fixture.store.apply({ snapshot: second });
    assert.equal(advanced.status, "applied");
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "second\n");
    await fixture.store.rollback(advanced.operationId);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "first\n");
    assert.equal(Object.values((await fixture.store.inspect()).cursors)[0].ref.assignment, 1);
    await fixture.store.apply({ snapshot: second });
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "second\n");
    assert.equal(await readFile(join(fixture.root, "unrelated.txt"), "utf8"), "user edit\n");
    assert.deepEqual(await readFile(join(fixture.repo.gitDirectory, "index")), index);
    assert.equal(
      (await fixture.git.run(fixture.root, ["rev-parse", "HEAD"])).stdout.toString().trim(),
      fixture.repo.head,
    );
  },
);

test(
  "terminal rollback journal overrides a stale projection and reapplication restores bytes",
  { timeout: 30_000 },
  async (t) => {
    let breakTerminal = false;
    const fixture = await applicationFixture((point) => {
      if (breakTerminal && point === "application.journal.terminal.rename.after")
        throw new Error("terminal rename interruption");
    });
    t.after(async () => {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const first = await fixture.snapshot(1, after("first\n"));
    const applied = await fixture.store.apply({ snapshot: first });
    const staleProjection = await readFile(join(fixture.store.directory, "snapshots.json"));
    breakTerminal = true;
    await assert.rejects(
      fixture.store.rollback(applied.operationId),
      /terminal rename interruption/,
    );
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
    assert.deepEqual((await fixture.store.inspect()).cursors, {});
    await writeFile(join(fixture.store.directory, "snapshots.json"), staleProjection);
    const recovered = await fixture.reopen();
    await recovered.reconcile();
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.store.directory, "snapshots.json"), "utf8")).cursors,
      {},
    );
    assert.equal((await recovered.apply({ snapshot: first })).status, "applied");
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "first\n");
  },
);

test(
  "conflicts and later edits refuse apply, rollback and recovery without changing user content",
  { timeout: 30_000 },
  async (t) => {
    let interruption = false;
    const fixture = await applicationFixture((point) => {
      if (interruption && point === "application.file.file.txt.rename.before")
        throw new Error("before replacement");
    });
    t.after(async () => {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const snapshot = await fixture.snapshot(1, after("first\n"));
    await writeFile(join(fixture.root, "file.txt"), "user-before\n");
    await assert.rejects(fixture.store.apply({ snapshot }), /conflicting changes/);
    await writeFile(join(fixture.root, "file.txt"), "base\n");
    interruption = true;
    await assert.rejects(fixture.store.apply({ snapshot }), /before replacement/);
    await writeFile(join(fixture.root, "file.txt"), "user-during\n");
    const recovered = await fixture.reopen();
    await assert.rejects(recovered.reconcile(), /later edits/);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "user-during\n");
    assert(await (await ApplicationLock.open(fixture.root)).inspect());
    await writeFile(join(fixture.root, "file.txt"), "base\n");
    const completed = await recovered.reconcile();
    assert(completed);
    await writeFile(join(fixture.root, "file.txt"), "user-after\n");
    await assert.rejects(recovered.rollback(completed.operationId), /later edits/);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "user-after\n");
    const same = await recovered.apply({ snapshot });
    assert.equal(same.status, "already_recorded");
    assert.equal(same.freshness, "changed");
  },
);

test(
  "application refuses another handoff until its operation lock is released",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await applicationFixture();
    t.after(async () => {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const snapshot = await fixture.snapshot(1, after("first\n"));
    const gate = await ApplicationLock.open(fixture.root);
    const lease = await gate.acquire({
      operationId: "other-handoff",
      ownerEpoch: "other-owner",
      purpose: "apply",
    });
    await assert.rejects(fixture.store.apply({ snapshot }), /owner|handoff/i);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
    await gate.release(lease);
    assert.equal((await fixture.store.apply({ snapshot })).status, "applied");
  },
);

test(
  "application validates changed secret paths, symlinks, gitlinks, destination links and repository metadata",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await applicationFixture();
    t.after(async () => {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const variants = [
      { path: ".env", content: "secret" },
      { path: "auth.json", content: "secret" },
      { path: "link", content: "file.txt", mode: "120000" as const },
      { path: "submodule", mode: "160000" as const, objectId: fixture.repo.head ?? undefined },
    ];
    for (const entry of variants) {
      const snapshot = await fixture.snapshot(1, [...fixture.baseline, entry]);
      await assert.rejects(fixture.store.apply({ snapshot }), /secret|symlink|submodule/);
    }
    const snapshot = await fixture.snapshot(1, after("first\n"));
    if (process.platform !== "win32") {
      await rm(join(fixture.root, "file.txt"));
      await symlink("unrelated.txt", join(fixture.root, "file.txt"));
      await assert.rejects(fixture.store.apply({ snapshot }), /symlink/);
      await rm(join(fixture.root, "file.txt"));
      await writeFile(join(fixture.root, "file.txt"), "base\n");
    }
    await fixture.git.run(fixture.root, ["checkout", "-qb", "different-branch"]);
    await assert.rejects(fixture.store.apply({ snapshot }), /HEAD, branch or index/);
    await fixture.git.run(fixture.root, [
      "checkout",
      "-q",
      fixture.repo.branch?.replace("refs/heads/", "") ?? "master",
    ]);
    await writeFile(join(fixture.root, "unrelated.txt"), "staged user change\n");
    await fixture.git.run(fixture.root, ["add", "unrelated.txt"]);
    await assert.rejects(fixture.store.apply({ snapshot }), /HEAD, branch or index/);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
  },
);

test(
  "application retains add/delete/mode changes and rejects a mismatched immutable Git tree",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await applicationFixture();
    t.after(async () => {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const snapshot = await fixture.snapshot(1, [
      { path: "added.txt", content: "new\n" },
      {
        path: "unrelated.txt",
        content: "untouched\n",
        mode: process.platform === "win32" ? "100644" : "100755",
      },
    ]);
    const invalid = await fixture.snapshot(1, after("different\n"), { tree: fixture.base.tree });
    await assert.rejects(fixture.store.apply({ snapshot: invalid }), /tree does not match/);
    const applied = await fixture.store.apply({ snapshot });
    await assert.rejects(readFile(join(fixture.root, "file.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(fixture.root, "added.txt"), "utf8"), "new\n");
    await fixture.store.rollback(applied.operationId);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
    await assert.rejects(readFile(join(fixture.root, "added.txt")), { code: "ENOENT" });
    await chmod(join(fixture.root, "unrelated.txt"), 0o644);
  },
);

test(
  "fresh processes recover killed destination writes and terminal rollback cursors",
  { timeout: 30_000 },
  async () => {
    const cases = [
      { direction: "apply", boundary: "application.validation.after", production: true },
      { direction: "apply", boundary: "application.helper.intent.publish.after", production: true },
      { direction: "apply", boundary: "application.journal.intent.rename.after" },
      { direction: "apply", boundary: "application.file.file.txt.rename.after" },
      { direction: "apply", boundary: "application.journal.terminal.rename.after" },
      { direction: "rollback", boundary: "application.journal.terminal.rename.after" },
      { direction: "rollback", boundary: "application.projection.publish.after" },
    ];
    for (const crash of cases) {
      const fixture = await applicationFixture();
      try {
        const snapshot = await fixture.snapshot(1, after("first\n"));
        const applied =
          crash.direction === "rollback" ? await fixture.store.apply({ snapshot }) : undefined;
        const payload = {
          ...crash,
          directory: fixture.directory,
          root: fixture.root,
          snapshot,
          operationId: applied?.operationId,
        };
        const exitCode = await new Promise<number | string | undefined>((resolve, reject) => {
          execFile(
            process.execPath,
            [
              fileURLToPath(new URL("./fixtures/rewrite-application-child.ts", import.meta.url)),
              JSON.stringify(payload),
            ],
            { env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
            (error, _stdout, stderr) => {
              if (!error) {
                reject(new Error("Fixture did not terminate at the requested boundary"));
                return;
              }
              if (error.code !== 85) {
                reject(new Error(`Unexpected child exit: ${error.message} ${stderr}`));
                return;
              }
              resolve(error.code);
            },
          );
        });
        assert.equal(exitCode, 85);
        const gate = await ApplicationLock.open(fixture.root);
        const retained = await gate.inspect();
        assert(retained);
        assert.notEqual(retained.owner.pid, process.pid);
        const recovered = crash.production
          ? await ApplicationStore.open({ destination: fixture.root, artifacts: fixture.artifacts })
          : await fixture.reopen();
        const reconciliation = await recovered.reconcile();
        if (!reconciliation && crash.direction === "apply") await recovered.apply({ snapshot });
        if (crash.direction === "rollback") {
          assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
          assert.deepEqual((await recovered.inspect()).cursors, {});
          assert.equal((await recovered.apply({ snapshot })).status, "applied");
        }
        assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "first\n");
        assert.equal(Object.values((await recovered.inspect()).cursors)[0].ref.assignment, 1);
        assert.equal(await gate.inspect(), undefined);
        await recovered.close();
      } finally {
        await fixture.store.close();
        await rm(fixture.directory, { recursive: true, force: true });
      }
    }
  },
);

test(
  "unconfirmed application helper cleanup retains cursor and application lock until explicit proof",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await applicationFixture();
    let stopped = false;
    const cleanup = (ownerEpoch: string) =>
      stopped
        ? { status: "stopped" as const, ownerEpoch, identities: [], evidence: [] }
        : {
            status: "unconfirmed" as const,
            ownerEpoch,
            identities: ["helper"],
            reasons: ["Helper exit remains unknown"],
            evidence: [],
          };
    class UncertainGit extends FixtureGit {
      override async close() {
        return cleanup(this.ownerEpoch);
      }
    }
    const application = await ApplicationStore.open({
      destination: fixture.root,
      artifacts: fixture.artifacts,
      createGit: (options) => new UncertainGit(options),
      recoverGit: async (_directory, ownerEpoch) => cleanup(ownerEpoch),
    });
    t.after(async () => {
      stopped = true;
      await application.close();
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const snapshot = await fixture.snapshot(1, after("first\n"));
    await assert.rejects(application.apply({ snapshot }), /cleanup is unconfirmed/);
    assert.deepEqual((await application.inspect()).cursors, {});
    assert(await (await ApplicationLock.open(fixture.root)).inspect());
    await assert.rejects(application.reconcile(), /activity is unconfirmed/);
    stopped = true;
    const receipt = await application.reconcile();
    assert.equal(receipt?.status, "applied");
    assert.equal(Object.values((await application.inspect()).cursors)[0].ref.assignment, 1);
    assert.equal(await (await ApplicationLock.open(fixture.root)).inspect(), undefined);
  },
);

test(
  "production application scopes stop supervised Git helpers before releasing application lock",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await applicationFixture();
    const application = await ApplicationStore.open({
      destination: fixture.root,
      artifacts: fixture.artifacts,
    });
    t.after(async () => {
      await application.close();
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const snapshot = await fixture.snapshot(1, after("first\n"));
    const applied = await application.apply({ snapshot });
    assert.equal(applied.status, "applied");
    assert.equal(await (await ApplicationLock.open(fixture.root)).inspect(), undefined);
    await application.rollback(applied.operationId);
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
    assert.equal((await application.apply({ snapshot })).status, "applied");
  },
);

test(
  "trusted explicit inputs compose into another worktree while ordinary delivery keeps its frozen destination",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await applicationFixture();
    const target = join(fixture.directory, "composed");
    await fixture.git.run(fixture.root, ["worktree", "add", "--detach", target, "HEAD"]);
    const application = await ApplicationStore.open({
      destination: target,
      artifacts: fixture.artifacts,
      createGit: (options) => new FixtureGit(options),
    });
    t.after(async () => {
      await application.close();
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const first = await fixture.snapshot(1, after("first\n"));
    const second = await fixture.snapshot(2, after("second\n"));
    await assert.rejects(application.apply({ snapshot: first }), /another destination/);
    assert.equal((await application.applyInput({ snapshot: first })).status, "applied");
    assert.equal(await readFile(join(target, "file.txt"), "utf8"), "first\n");
    assert.equal(await readFile(join(fixture.root, "file.txt"), "utf8"), "base\n");
    assert.equal((await application.inspect()).operations[0].repository.root, target);
    assert.equal((await application.inspect()).operations[0].mode, "input");
    assert.equal((await application.applyInput({ snapshot: second })).status, "applied");
    assert.equal(await readFile(join(target, "file.txt"), "utf8"), "second\n");
  },
);
