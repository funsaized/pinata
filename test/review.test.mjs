import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { digest, readJson, validateTask } from "../lib/core.mjs";
import { init } from "../lib/pinata.mjs";
import { fixture, task, settled, gitIn } from "./helpers.mjs";

const write = (cwd, file, data) => fs.writeFile(path.join(cwd, file), data);
const reviewer = (id, target, scenario = {}) => task(id, "reviewer", scenario, target);
const target = async (f, id) =>
  (await readJson(path.join(f.run, "tasks", id, "1", "task.json"))).reviewTarget;

test("a reviewer reviews uncommitted changes and binds its verdict to both commits", async (t) => {
  const f = await fixture(
    t,
    [
      reviewer("look", { reviewBase: "HEAD" }, { expect: { "a.txt": "work in progress" } }),
      reviewer("strict", { reviewBase: "HEAD" }, { reject: true }),
    ],
    { job: { allowWrites: false }, before: ({ cwd }) => write(cwd, "a.txt", "work in progress") },
  );
  const s = await settled(f);
  assert.deepEqual(
    s.tasks.map((x) => x.status),
    ["succeeded", "rejected"],
  );
  const reviewTarget = await target(f, "look");
  const { subject } = reviewTarget;
  assert.equal(subject.kind, "uncommitted");
  assert.equal(subject.base, f.created.base.head);
  assert.equal(subject.head, f.created.base.commit);
  assert.equal(reviewTarget.taskId, null);
  assert.equal(reviewTarget.fingerprint, digest(subject));
  assert.deepEqual(reviewTarget.changedFiles, [{ status: "M", path: "a.txt" }]);
  assert.match(await fs.readFile(reviewTarget.diff, "utf8"), /\+work in progress/);
  assert.equal(s.tasks[0].reviewSubject.kind, "uncommitted");
  const run = await f.manifest();
  assert.equal(path.dirname(run.tasks[0].worktree), path.join(f.run, "worktrees"));
  assert.equal(run.tasks[0].worktree, run.tasks[1].worktree);
});

test("a branch review covers commits since the base and uncommitted changes", async (t) => {
  let main;
  const f = await fixture(t, [], {
    job: { allowWrites: false },
    async before({ cwd }) {
      main = await gitIn(cwd, "rev-parse", "--abbrev-ref", "HEAD");
      await gitIn(cwd, "checkout", "-qb", "feature");
      await write(cwd, "b.txt", "on the branch");
      await gitIn(cwd, "commit", "-qam", "Branch change");
      await write(cwd, "a.txt", "work in progress");
    },
  });
  await assert.rejects(
    init({ ...f.job, tasks: [reviewer("look", { reviewBase: "no-such-branch" })] }),
    /not a commit/,
  );
  const created = await init({ ...f.job, tasks: [reviewer("look", { reviewBase: main })] });
  const s = await settled({ run: created.run });
  assert.equal(s.tasks[0].status, "succeeded");
  const { subject, changedFiles } = await target({ run: created.run }, "look");
  assert.equal(subject.kind, "branch");
  assert.equal(subject.ref, main);
  assert.equal(subject.base, await gitIn(f.cwd, "rev-parse", main));
  assert.deepEqual(
    changedFiles.map((c) => c.path),
    ["a.txt", "b.txt"],
  );
});

test("reviews of existing changes are validated before anything runs", async (t) => {
  const f = await fixture(t, [], { job: { allowWrites: true } });
  await assert.rejects(
    init({ ...f.job, tasks: [reviewer("look", { reviewBase: "HEAD" })] }),
    /Nothing to review/,
  );
  const base = { id: "r", role: "reviewer", task: "Review", acceptance: ["Evidence"] };
  assert.throws(
    () => validateTask({ ...base, reviewOf: "x", reviewBase: "HEAD" }),
    /exactly one of reviewOf, reviewBase, or reviewPr/,
  );
  assert.throws(() => validateTask(base), /exactly one/);
  assert.throws(() => validateTask({ ...base, reviewBase: "--output=x" }), /Git revision/);
  assert.throws(() => validateTask({ ...base, reviewBase: "a b" }), /Git revision/);
  assert.throws(() => validateTask({ ...base, reviewPr: 0 }), /pull request number/);
  assert.throws(
    () => validateTask({ ...base, role: "scout", reviewBase: "HEAD" }),
    /only reviewers use reviewBase/,
  );
  await write(f.cwd, "a.txt", "work in progress");
  await assert.rejects(
    init({
      ...f.job,
      tasks: [
        task(
          "build",
          "builder",
          {},
          { ownership: ["b.txt"], noChecksReason: "Fixture text change inspected directly" },
        ),
        reviewer("look", { reviewBase: "HEAD", after: ["build"] }),
      ],
    }),
    /use reviewOf instead of reviewBase or reviewPr/,
  );
});

async function pullRequest(dir, cwd, { headOverride } = {}) {
  const main = await gitIn(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const remote = path.join(dir, "github.com", "acme", "widget.git");
  await fs.mkdir(path.dirname(remote), { recursive: true });
  await gitIn(dir, "init", "-q", "--bare", remote);
  await gitIn(cwd, "remote", "add", "origin", remote);
  await gitIn(cwd, "push", "-q", "origin", main);
  await gitIn(cwd, "checkout", "-qb", "contributor");
  await write(cwd, "b.txt", "from the pull request");
  await gitIn(cwd, "commit", "-qam", "Pull request change");
  const head = await gitIn(cwd, "rev-parse", "HEAD");
  await gitIn(cwd, "push", "-q", "origin", "HEAD:refs/pull/7/head");
  await gitIn(cwd, "checkout", "-q", main);
  await gitIn(cwd, "branch", "-qD", "contributor");
  const bin = path.join(dir, "bin");
  await fs.mkdir(bin);
  const view = {
    number: 7,
    title: "Fix the widget",
    url: "https://github.com/acme/widget/pull/7",
    headRefOid: headOverride ?? head,
    baseRefName: main,
  };
  await fs.writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh\n[ "$1 $2 $3" = "pr view 7" ] || exit 2\nprintf '%s\\n' '${JSON.stringify(view)}'\n`,
    { mode: 0o755 },
  );
  return { head, bin };
}

test("a pull request is fetched into a private ref and reviewed at its head", async (t) => {
  let pr;
  const env = { PATH: process.env.PATH };
  const f = await fixture(t, [], {
    job: { allowWrites: false },
    env,
    async before({ dir, cwd }) {
      pr = await pullRequest(dir, cwd);
    },
  });
  process.env.PATH = `${pr.bin}${path.delimiter}${env.PATH}`;
  const created = await init({
    ...f.job,
    tasks: [reviewer("look", { reviewPr: 7 }, { expect: { "b.txt": "from the pull request" } })],
  });
  const s = await settled({ run: created.run });
  assert.equal(s.tasks[0].status, "succeeded");
  const { subject, changedFiles } = await target({ run: created.run }, "look");
  assert.equal(subject.kind, "pull-request");
  assert.equal(subject.head, pr.head);
  assert.deepEqual(subject.pr, {
    number: 7,
    title: "Fix the widget",
    url: "https://github.com/acme/widget/pull/7",
  });
  assert.deepEqual(changedFiles, [{ status: "M", path: "b.txt" }]);
  assert.equal(await gitIn(f.cwd, "rev-parse", `refs/pinata/${created.id}/pr-7`), pr.head);
  // The user's checkout never moves to the pull request.
  assert.equal(await fs.readFile(path.join(f.cwd, "b.txt"), "utf8"), "original");
});

test("a pull request whose head changed while fetching is refused", async (t) => {
  let pr;
  const env = { PATH: process.env.PATH };
  const f = await fixture(t, [], {
    job: { allowWrites: false },
    env,
    async before({ dir, cwd }) {
      pr = await pullRequest(dir, cwd, { headOverride: "0".repeat(40) });
    },
  });
  process.env.PATH = `${pr.bin}${path.delimiter}${env.PATH}`;
  await assert.rejects(
    init({ ...f.job, tasks: [reviewer("look", { reviewPr: 7 })] }),
    /changed while it was fetched/,
  );
  assert.equal(await gitIn(f.cwd, "for-each-ref", "refs/pinata/"), "");
});
