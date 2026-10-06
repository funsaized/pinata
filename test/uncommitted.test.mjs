import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ROOT, exists } from "../lib/core.mjs";
import { init, integrate, rollback } from "../lib/pinata.mjs";
import { fixture, task, settled, repository, gitIn } from "./helpers.mjs";

const write = (cwd, file, data) => fs.writeFile(path.join(cwd, file), data);
const read = (cwd, file) => fs.readFile(path.join(cwd, file), "utf8");
const review = (name, target) => task(name, "reviewer", {}, { after: [target], reviewOf: target });

test("workers start from uncommitted and untracked changes; the user's index is untouched", async (t) => {
  let before;
  const f = await fixture(
    t,
    [
      task("look", "scout", {
        expect: { "a.txt": "work in progress", "b.txt": "staged", "new.txt": "untracked" },
        absent: ["ignored/local.txt"],
      }),
    ],
    {
      async before({ cwd }) {
        await write(cwd, "a.txt", "work in progress");
        await write(cwd, "b.txt", "staged");
        await gitIn(cwd, "add", "b.txt");
        await write(cwd, "new.txt", "untracked");
        await fs.mkdir(path.join(cwd, "ignored"));
        await write(cwd, "ignored/local.txt", "ignored");
        before = {
          head: await gitIn(cwd, "rev-parse", "HEAD"),
          status: await gitIn(cwd, "status", "--porcelain"),
          index: await gitIn(cwd, "diff", "--cached"),
        };
      },
    },
  );
  assert.deepEqual(f.created.base.uncommittedFiles, ["a.txt", "b.txt", "new.txt"]);
  assert.equal(f.created.base.head, before.head);
  assert.notEqual(f.created.base.commit, before.head);
  const s = await settled(f);
  assert.equal(s.tasks[0].status, "succeeded");
  assert.equal(await gitIn(f.cwd, "rev-parse", "HEAD"), before.head);
  assert.equal(await gitIn(f.cwd, "status", "--porcelain"), before.status);
  assert.equal(await gitIn(f.cwd, "diff", "--cached"), before.index);
  const run = await f.manifest();
  assert.equal(
    await gitIn(f.cwd, "rev-parse", `refs/pinata/${run.id}/base`),
    f.created.base.commit,
  );
  assert.equal(await gitIn(f.cwd, "rev-parse", `${f.created.base.commit}^`), before.head);
});

test("builders change files on top of uncommitted work; integration and rollback keep it", async (t) => {
  const f = await fixture(
    t,
    [
      task(
        "build",
        "builder",
        { expect: { "a.txt": "work in progress" }, write: { "a.txt": "built" } },
        { ownership: ["a.txt"], noChecksReason: "Fixture text change inspected directly" },
      ),
      review("check", "build"),
    ],
    { before: ({ cwd }) => write(cwd, "a.txt", "work in progress") },
  );
  const s = await settled(f);
  assert.deepEqual(
    s.tasks.map((x) => x.status),
    ["succeeded", "succeeded"],
  );
  const integrated = await integrate(f.run);
  assert.equal(integrated.integration.status, "verified");
  assert.equal(await read(f.cwd, "a.txt"), "built");
  await rollback(f.run);
  assert.equal(await read(f.cwd, "a.txt"), "work in progress");
});

test("integration refuses to overwrite uncommitted work that changed after the run started", async (t) => {
  const f = await fixture(
    t,
    [
      task(
        "build",
        "builder",
        { write: { "a.txt": "built" } },
        { ownership: ["a.txt"], noChecksReason: "Fixture text change inspected directly" },
      ),
      review("check", "build"),
    ],
    { before: ({ cwd }) => write(cwd, "a.txt", "work in progress") },
  );
  await settled(f);
  await write(f.cwd, "a.txt", "edited again");
  await assert.rejects(integrate(f.run), /Integration conflicts with existing changes/);
  assert.equal(await read(f.cwd, "a.txt"), "edited again");
});

test("a sparse checkout's snapshot keeps the files outside the sparse patterns", async (t) => {
  const f = await fixture(t, [task("look")], {
    async before({ cwd }) {
      await gitIn(cwd, "sparse-checkout", "set", "--no-cone", "/a.txt", "/b.txt", "/.gitignore");
      await write(cwd, "a.txt", "work in progress");
    },
  });
  assert.equal(await exists(path.join(f.cwd, "untouched.txt")), false);
  assert.deepEqual(f.created.base.uncommittedFiles, ["a.txt"]);
  assert.equal(await gitIn(f.cwd, "show", `${f.created.base.commit}:untouched.txt`), "original");
  await settled(f);
});

test("includeUncommitted false starts workers from HEAD", async (t) => {
  const f = await fixture(t, [task("look", "scout", { expect: { "a.txt": "original" } })], {
    config: { includeUncommitted: false },
    before: ({ cwd }) => write(cwd, "a.txt", "work in progress"),
  });
  assert.deepEqual(f.created.base.uncommittedFiles, []);
  assert.equal(f.created.base.commit, f.created.base.head);
  const s = await settled(f);
  assert.equal(s.tasks[0].status, "succeeded");
});

test("a clean checkout uses HEAD directly and creates no ref", async (t) => {
  const f = await fixture(t, [task("look")]);
  assert.equal(f.created.base.commit, f.created.base.head);
  assert.equal(await gitIn(f.cwd, "for-each-ref", "refs/pinata/"), "");
});

test("a rejected job leaves no run directory and no snapshot ref", async () => {
  const { dir, cwd } = await repository();
  try {
    await write(cwd, "a.txt", "work in progress");
    await assert.rejects(
      init({
        cwd,
        approval: "Disposable local test only",
        config: {
          pi: path.join(ROOT, "test/fixtures/pi.mjs"),
          herdr: path.join(ROOT, "test/fixtures/herdr.mjs"),
          session: "fixture",
          models: { default: { provider: "fixture", id: "fixture-model", thinking: "off" } },
        },
        // Fails after the snapshot ref exists, so cleanup is exercised.
        tasks: [task("check", "reviewer", {}, { reviewBase: "no-such-branch" })],
      }),
      /not a commit in this repository/,
    );
    assert.equal(await exists(path.join(cwd, ".git", "pinata")), false);
    assert.equal(await gitIn(cwd, "for-each-ref", "refs/pinata/"), "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
