import { taskSpec } from "../../engine/core/definitions.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Check, TaskSpec } from "../../engine/core/types.ts";
import { validateGraph } from "../../engine/core/validate.ts";
import { integrate, rollback, writeRunRecord } from "../../engine/verify/integrate.ts";
import { handoff } from "../../engine/verify/evidence.ts";
import {
  destination,
  verifyDestination,
  verificationStatus,
  withDestination,
} from "../../engine/verify/destination.ts";
import { integrationStatus } from "../../engine/pi/ui.ts";
import { headCommit } from "../../engine/workspace/snapshot.ts";
import { fauxWorld, type FauxTurn } from "./faux.ts";
import { spec } from "./helpers.ts";

const node = process.execPath;
const call = (name: string, args: Record<string, any>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const submit = (extra: Record<string, any>) =>
  call("submit_result", {
    status: "succeeded",
    summary: "done",
    changedFiles: [],
    checks: [],
    findings: [],
    blockers: [],
    ...extra,
  });

// Builders write the files named in their task JSON; reviewers approve unless told otherwise.
function responder(turn: FauxTurn) {
  const m = /# Task [a-z0-9-]+ \([a-z]+\)\n\n(\{[^\n]*\})/.exec(turn.text);
  const s = m ? JSON.parse(m[1]) : {};
  if (turn.role === "builder") {
    if (turn.round === 0)
      return fauxAssistantMessage(
        [
          ...Object.entries<string>(s.write ?? {}).map(([path, content]) =>
            fauxToolCall("write", { path, content }),
          ),
          ...(s.bash ? [fauxToolCall("bash", { command: s.bash })] : []),
        ],
        { stopReason: "toolUse" },
      );
    return submit({ changedFiles: s.claim ?? Object.keys(s.write ?? {}) });
  }
  const verdict = turn.text.includes("prior approval is invalid")
    ? "approve"
    : (s.verdict ?? "approve");
  return submit({
    review: { verdict },
    findings: verdict === "approve" ? [] : [{ severity: "high", message: "bug", evidence: "x:1" }],
  });
}

async function integrated(
  t: TestContext,
  files: Record<string, string>,
  tasks: TaskSpec[],
  checks: Check[] = [],
  before?: (repo: string) => Promise<void>,
) {
  const world = await fauxWorld(t, responder, { files });
  if (before) await before(world.repo);
  const head = await headCommit(world.repo);
  const handle = await world.run(tasks, { allowWrites: true });
  await writeRunRecord(handle.dir, {
    id: handle.id,
    root: world.repo,
    head,
    tasks: validateGraph(tasks, { allowWrites: true }).map(taskSpec),
    allowWrites: true,
    integratedChecks: checks,
    noIntegratedChecksReason: checks.length ? null : "fixture",
    passEnv: [],
    taskMs: 60_000,
  });
  const view = await handle.done;
  return { world, handle, view };
}

const build = (id: string, write: Record<string, string>, extra: Partial<TaskSpec> = {}) =>
  spec(id, "builder", {
    task: JSON.stringify({ write }),
    ownership: Object.keys(write),
    noChecksReason: "fixture",
    ...extra,
  });
const review = (id: string, of: string, verdict = "approve") =>
  spec(id, "reviewer", { task: JSON.stringify({ verdict }), reviewOf: of, after: [of] });

test("integration applies approved changes without staging or committing; rollback restores them", async (t) => {
  const { world, handle } = await integrated(
    t,
    { "a.txt": "old\n", "keep.txt": "keep\n" },
    [build("build", { "a.txt": "new\n", "added.txt": "added\n" }), review("review", "build")],
    [
      {
        id: "verify",
        argv: [
          node,
          "-e",
          "process.exit(require('fs').readFileSync('a.txt','utf8')==='new\\n'?0:1)",
        ],
      },
    ],
    async (repo) => writeFile(join(repo, "keep.txt"), "user's uncommitted work\n"),
  );
  const headBefore = await headCommit(world.repo);
  const r = await integrate(handle.dir);
  assert.equal(r.status, "verified");
  assert.deepEqual(r.files.sort(), ["a.txt", "added.txt"]);
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(world.repo, "added.txt"), "utf8"), "added\n");
  assert.equal(await readFile(join(world.repo, "keep.txt"), "utf8"), "user's uncommitted work\n");
  assert.equal(world.fixture.git("diff", "--cached", "--name-only"), "", "the index is untouched");
  assert.equal(await headCommit(world.repo), headBefore, "nothing was committed");
  assert.equal((await integrate(handle.dir)).status, "verified", "integration is repeatable");
  const back = await rollback(handle.dir);
  assert.equal(back.status, "rolled_back");
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "old\n");
  assert(!existsSync(join(world.repo, "added.txt")));
  await assert.rejects(rollback(handle.dir), /Already rolled back/);
});

test("integration needs every task succeeded and a current approving review per builder", async (t) => {
  const rejected = await integrated(t, { "a.txt": "a" }, [
    build("build", { "a.txt": "b" }),
    review("review", "build", "changes_requested"),
  ]);
  await assert.rejects(integrate(rejected.handle.dir), /Every task must succeed/);
  const unreviewed = await integrated(t, { "a.txt": "a" }, [build("build", { "a.txt": "b" })]);
  await assert.rejects(integrate(unreviewed.handle.dir), /Independent review required for build/);
});

test("integration accepts an unrelated moved HEAD but refuses subsequent edits and secret files", async (t) => {
  const moved = await integrated(t, { "a.txt": "a" }, [
    build("build", { "a.txt": "b" }),
    review("review", "build"),
  ]);
  await writeFile(join(moved.world.repo, "other.txt"), "x");
  moved.world.fixture.git("add", "other.txt");
  moved.world.fixture.git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@e",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "moved",
  );
  assert.equal((await integrate(moved.handle.dir)).status, "applied_unverified");
  assert.equal(await readFile(join(moved.world.repo, "other.txt"), "utf8"), "x");
  const edited = await integrated(t, { "a.txt": "a" }, [
    build("build", { "a.txt": "b" }),
    review("review", "build"),
  ]);
  await writeFile(join(edited.world.repo, "a.txt"), "user edited this meanwhile\n");
  await assert.rejects(
    integrate(edited.handle.dir),
    /conflicts with changes made since the run started: "a.txt"/,
  );
  assert.equal(
    await readFile(join(edited.world.repo, "a.txt"), "utf8"),
    "user edited this meanwhile\n",
  );
  const secret = await integrated(t, { "a.txt": "a" }, [
    build("build", { ".env": "TOKEN=x" }),
    review("review", "build"),
  ]);
  await assert.rejects(integrate(secret.handle.dir), /secret-bearing file: ".env"/);
});

test("a failed integrated check is reported, not delivered as success", async (t) => {
  const { handle } = await integrated(
    t,
    { "a.txt": "a" },
    [build("build", { "a.txt": "b" }), review("review", "build")],
    [{ id: "unit", argv: [node, "-e", "process.exit(1)"] }],
  );
  const r = await integrate(handle.dir);
  assert.equal(r.status, "verification_failed");
  assert.deepEqual(r.checks, [{ id: "unit", passed: false, reason: null }]);
});

test("after a repair, integration undoes the earlier integration and applies the new evidence", async (t) => {
  let fixed = false;
  const world = await fauxWorld(
    t,
    (turn) => {
      if (turn.role === "builder" && turn.text.includes("Repair feedback")) {
        fixed = true;
        return turn.round === 0
          ? call("write", { path: "a.txt", content: "fixed\n" })
          : submit({ changedFiles: ["a.txt", "extra.txt"] });
      }
      return responder(turn);
    },
    { files: { "a.txt": "old\n" } },
  );
  const tasks = [
    build("build", { "a.txt": "first\n", "extra.txt": "extra\n" }),
    review("review", "build"),
  ];
  const head = await headCommit(world.repo);
  const handle = await world.run(tasks, { allowWrites: true });
  await writeRunRecord(handle.dir, {
    id: handle.id,
    root: world.repo,
    head,
    tasks: validateGraph(tasks, { allowWrites: true }).map(taskSpec),
    allowWrites: true,
    integratedChecks: [],
    noIntegratedChecksReason: "fixture",
    passEnv: [],
    taskMs: 60_000,
  });
  await handle.done;
  assert.equal((await integrate(handle.dir)).status, "applied_unverified");
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "first\n");
  world.engine.repair(handle.id, "build", "a.txt must say fixed");
  const view = await handle.done;
  assert(fixed);
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  assert.equal((await integrate(handle.dir)).status, "applied_unverified");
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "fixed\n");
  assert.equal(await readFile(join(world.repo, "extra.txt"), "utf8"), "extra\n");
});

test("integration works through paths with spaces, quotes and Unicode", async (t) => {
  const file = process.platform === "win32" ? "new ' 雨 file.txt" : "new ' 雨\nfile.txt";
  const { world, handle } = await integrated(t, { "a.txt": "a" }, [
    build("build", { [file]: "value" }),
    review("review", "build"),
  ]);
  assert.equal((await integrate(handle.dir)).status, "applied_unverified");
  assert.equal(await readFile(join(world.repo, file), "utf8"), "value");
});

const commit = (world: Awaited<ReturnType<typeof fauxWorld>>, message: string) => {
  world.fixture.git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@e",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  );
};
const passing = [{ id: "pass", argv: [node, "-e", "console.log('checked')"] }];

async function recordedRun(world: Awaited<ReturnType<typeof fauxWorld>>, tasks: TaskSpec[]) {
  const head = await headCommit(world.repo);
  const handle = await world.run(tasks, { allowWrites: true });
  await writeRunRecord(handle.dir, {
    id: handle.id,
    root: world.repo,
    head,
    tasks: validateGraph(tasks, { allowWrites: true }).map(taskSpec),
    allowWrites: true,
    integratedChecks: passing,
    noIntegratedChecksReason: null,
    passEnv: [],
    taskMs: 60000,
  });
  return handle;
}

test("parallel runs survive the first feature being integrated and committed", async (t) => {
  const world = await fauxWorld(t, responder, { files: { "a.txt": "old A", "b.txt": "old B" } });
  const first = await recordedRun(world, [build("a", { "a.txt": "new A" }), review("ra", "a")]);
  const second = await recordedRun(world, [build("b", { "b.txt": "new B" }), review("rb", "b")]);
  await Promise.all([first.done, second.done]);
  const evidenceBefore = await handoff(second.dir);
  assert.equal((await integrate(first.dir)).status, "verified");
  world.fixture.git("add", "a.txt");
  commit(world, "feature A");
  const head = await headCommit(world.repo);
  assert.equal((await handoff(second.dir)).evidenceDigest, evidenceBefore.evidenceDigest);
  const result = await integrate(second.dir);
  assert.equal(result.status, "verified");
  assert.equal(result.verification.destination.head, head);
  assert.notEqual(result.verification.destination.head, evidenceBefore.startHead);
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "new A");
  assert.equal(await readFile(join(world.repo, "b.txt"), "utf8"), "new B");
  assert.equal(world.fixture.git("diff", "--cached", "--name-only"), "");
  assert.equal(await integrationStatus(first.dir), "historical");
  await assert.rejects(rollback(first.dir), /HEAD moved/);
  assert.equal((await rollback(second.dir)).status, "rolled_back");
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "new A");
});

test("handoff preserves bases, binary changes and check logs without reading live builder edits", async (t) => {
  const { world, handle } = await integrated(
    t,
    { "a.txt": "base" },
    [
      build(
        "build",
        { "a.txt": "approved\u0000binary" },
        { checks: passing, noChecksReason: undefined },
      ),
      review("review", "build"),
    ],
    [],
    async (root) => writeFile(join(root, "user.txt"), "uncommitted input"),
  );
  const before = await destination(world.repo);
  const built = handle.results().get("build")!.data as any;
  await writeFile(join(built.worktree, "a.txt"), "unreviewed worktree edit");
  const h = await handoff(handle.dir);
  assert.deepEqual(await destination(world.repo), before);
  assert.equal(h.scope, "builder-artifacts");
  assert.equal(h.destinationVerification, "not-performed");
  assert.notEqual(h.builders[0].baseCommit, h.startHead, "uncommitted snapshot has its own base");
  assert.match(await readFile(h.builders[0].patch, "utf8"), /GIT binary patch/);
  assert.equal(await readFile(h.builders[0].checks[0].stdout, "utf8"), "checked\n");
  assert.equal(
    world.fixture
      .git(
        "cat-file",
        "-t",
        `refs/pinata/${handle.id}/evidence/build/${h.builders[0].fingerprint}/tree`,
      )
      .trim(),
    "tree",
  );
  assert.equal((await integrate(handle.dir)).status, "applied_unverified");
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "approved\u0000binary");
});

test("composed builder bases and dependency order are included in the handoff", async (t) => {
  const { handle } = await integrated(t, { "a.txt": "base" }, [
    build("first", { "a.txt": "first" }),
    build("second", { "a.txt": "second" }, { after: ["first"] }),
    review("rfirst", "first"),
    review("rsecond", "second"),
  ]);
  const h = await handoff(handle.dir);
  assert.deepEqual(
    h.builders.map((b) => b.task),
    ["first", "second"],
  );
  assert.equal(h.builders[1].changes.base, h.builders[0].changes.tree);
  assert.equal((await integrate(handle.dir)).status, "applied_unverified");
});

test("committed overlaps and addition collisions fail preflight before any file is written", async (t) => {
  const { world, handle } = await integrated(t, { "a.txt": "a", "b.txt": "b" }, [
    build("build", { "a.txt": "new a", "b.txt": "new b", "new.txt": "builder" }),
    review("r", "build"),
  ]);
  await writeFile(join(world.repo, "b.txt"), "subsequent commit");
  world.fixture.git("add", "b.txt");
  commit(world, "overlap");
  await writeFile(join(world.repo, "new.txt"), "user addition");
  await assert.rejects(integrate(handle.dir), /b.txt.*new.txt/);
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "a");
  assert.equal(await readFile(join(world.repo, "new.txt"), "utf8"), "user addition");
  assert.equal((await handoff(handle.dir)).scope, "builder-artifacts");
});

test("external reconciliation gets checks scoped to the destination, never inherited review", async (t) => {
  const { world, handle } = await integrated(
    t,
    { "a.txt": "a" },
    [build("build", { "a.txt": "b" }), review("r", "build")],
    passing,
  );
  const before = await verifyDestination(handle.dir);
  assert.equal(before.status, "verified");
  assert.equal(before.application, "different", "passing checks do not prove application");
  await writeFile(join(world.repo, "a.txt"), "reconciled by coordinator");
  const result = await verifyDestination(handle.dir);
  assert.equal(result.status, "verified");
  assert.equal(result.scope, "destination-checks");
  assert.equal(result.review, "builder-artifacts-only");
  assert.deepEqual(result.differingPaths, ["a.txt"]);
  assert(!existsSync(join(handle.dir, "integration", "journal.json")));
  assert.equal((await verificationStatus(handle.dir))!.freshness, "current");
  await writeFile(join(world.repo, "a.txt"), "later edit");
  assert.equal((await verificationStatus(handle.dir))!.freshness, "historical");
  assert.equal(
    await readFile(result.checks[0].stdout, "utf8"),
    "checked\n",
    "earlier check logs survive retries",
  );
});

test("destination checks detect mutations of already dirty and untracked files", async (t) => {
  const { world, handle } = await integrated(
    t,
    { "a.txt": "a" },
    [build("build", { "a.txt": "b" }), review("r", "build")],
    [{ id: "mutate", argv: [node, "-e", "require('fs').writeFileSync('a.txt','check mutation')"] }],
  );
  const result = await integrate(handle.dir);
  assert.equal(result.status, "verification_failed");
  assert.equal(result.verification.status, "source_changed");
  await assert.rejects(rollback(handle.dir), /Rollback conflicts/);
  await writeFile(join(world.repo, "untracked.txt"), "before");
  const again = await verifyDestination(handle.dir, {
    checks: [
      { id: "mutate", argv: [node, "-e", "require('fs').writeFileSync('untracked.txt','after')"] },
    ],
  });
  assert.equal(again.status, "source_changed");
});

test("omitted checks and cancellation never count as verified destination evidence", async (t) => {
  const { handle } = await integrated(t, { "a.txt": "a" }, [
    build("build", { "a.txt": "b" }),
    review("r", "build"),
  ]);
  assert.equal((await integrate(handle.dir)).status, "applied_unverified");
  const empty = await verifyDestination(handle.dir);
  assert.equal(empty.status, "not_run");
  assert.equal(empty.noChecksReason, "fixture");
  const cancelled = await verifyDestination(handle.dir, { checks: passing }, AbortSignal.abort());
  assert.equal(cancelled.status, "verification_failed");
  assert.equal(cancelled.reason, "cancelled");
});

test("stale reviews, corrupted changes and changed check logs cannot be handed off", async (t) => {
  const { handle } = await integrated(t, { "a.txt": "a" }, [
    build("build", { "a.txt": "b" }, { checks: passing, noChecksReason: undefined }),
    review("r", "build"),
  ]);
  const reviewPath = join(handle.dir, "results", "r.json");
  const original = await readFile(reviewPath, "utf8");
  const stale = JSON.parse(original);
  stale.result.review.fingerprint = "stale";
  await writeFile(reviewPath, JSON.stringify(stale));
  await assert.rejects(handoff(handle.dir), /rejected or stale/);
  await writeFile(reviewPath, original);
  const buildPath = join(handle.dir, "results", "build.json");
  const built = JSON.parse(await readFile(buildPath, "utf8"));
  built.data.changes.changes[0].newBlob = built.data.changes.changes[0].oldBlob;
  await writeFile(buildPath, JSON.stringify(built));
  await assert.rejects(handoff(handle.dir), /does not match its trees/);
  built.data.changes.changes[0].newBlob = (
    handle.results().get("build")!.data as any
  ).changes.changes[0].newBlob;
  await writeFile(buildPath, JSON.stringify(built));
  await writeFile(built.data.checks[0].stdout, "tampered");
  await assert.rejects(handoff(handle.dir), /log .* stale or corrupt/);
});

test("interrupted application resumes, later edits prevent rollback, and legacy journals are not promoted", async (t) => {
  const { world, handle } = await integrated(
    t,
    { "a.txt": "a" },
    [build("build", { "a.txt": "b", "new.txt": "new" }), review("r", "build")],
    passing,
  );
  await integrate(handle.dir);
  const path = join(handle.dir, "integration", "journal.json");
  const journal = JSON.parse(await readFile(path, "utf8"));
  journal.status = "applying";
  await writeFile(path, JSON.stringify(journal));
  await unlink(join(world.repo, "new.txt"));
  assert.equal((await integrate(handle.dir)).status, "verified");
  await writeFile(join(world.repo, "a.txt"), "later edit");
  await assert.rejects(rollback(handle.dir), /Rollback conflicts/);
  assert.equal(await readFile(join(world.repo, "new.txt"), "utf8"), "new");
  journal.schemaVersion = 1;
  delete journal.destination;
  await writeFile(path, JSON.stringify(journal));
  await assert.rejects(integrate(handle.dir), /Legacy journal/);
  await assert.rejects(rollback(handle.dir), /Legacy journal/);
  assert.equal(await integrationStatus(handle.dir), "legacy_unverified");
});

test("destination operations cannot interleave across callers", async (t) => {
  const { world, handle } = await integrated(t, { "a.txt": "a" }, [
    build("build", { "a.txt": "b" }),
    review("r", "build"),
  ]);
  await withDestination(world.repo, async () => {
    await assert.rejects(integrate(handle.dir), /already locked/);
    await assert.rejects(verifyDestination(handle.dir), /already locked/);
    assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "a");
  });
  assert.equal((await integrate(handle.dir)).status, "applied_unverified");
});

test("repair immediately invalidates saved approvals and preserves an earlier handoff", async (t) => {
  const { world, handle } = await integrated(t, { "a.txt": "a" }, [
    build("build", { "a.txt": "b" }, { checks: passing, noChecksReason: undefined }),
    review("r", "build"),
  ]);
  const original = await handoff(handle.dir);
  const manifest = await readFile(original.manifest, "utf8");
  world.engine.repair(handle.id, "build", "recheck the artifact");
  assert(!existsSync(join(handle.dir, "results", "build.json")));
  assert(!existsSync(join(handle.dir, "results", "r.json")));
  await assert.rejects(handoff(handle.dir));
  await handle.done;
  const repaired = await handoff(handle.dir);
  assert.notEqual(repaired.evidenceDigest, original.evidenceDigest);
  assert.equal(await readFile(original.manifest, "utf8"), manifest);
  assert.equal(await readFile(original.builders[0].checks[0].stdout, "utf8"), "checked\n");
});

test("staging after application protects the user's index and blocks automatic rollback", async (t) => {
  const { world, handle } = await integrated(t, { "a.txt": "a" }, [
    build("build", { "a.txt": "b" }),
    review("r", "build"),
  ]);
  await integrate(handle.dir);
  world.fixture.git("add", "a.txt");
  await assert.rejects(rollback(handle.dir), /index changed/);
  await assert.rejects(integrate(handle.dir), /index changed/);
  assert.equal(world.fixture.git("show", ":a.txt"), "b");
});

test("deletions refuse later edits and remain reversible after exact application", async (t) => {
  const { world, handle } = await integrated(t, { "a.txt": "base", "keep.txt": "keep" }, [
    build(
      "build",
      {},
      {
        ownership: ["a.txt", "new.txt"],
        task: JSON.stringify({
          write: { "new.txt": "added" },
          bash: "node -e \"require('fs').unlinkSync('a.txt')\"",
          claim: ["a.txt", "new.txt"],
        }),
      },
    ),
    review("r", "build"),
  ]);
  assert.equal(
    (await handoff(handle.dir)).builders[0].changes.changes.find((c) => c.path === "a.txt")!.status,
    "D",
  );
  await writeFile(join(world.repo, "a.txt"), "later");
  await assert.rejects(integrate(handle.dir), /conflicts/);
  assert(!existsSync(join(world.repo, "new.txt")));
  await writeFile(join(world.repo, "a.txt"), "base");
  await integrate(handle.dir);
  assert(!existsSync(join(world.repo, "a.txt")));
  await rollback(handle.dir);
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "base");
});

test(
  "subsequent executable-bit changes and symlinks are never overwritten",
  { skip: process.platform === "win32" },
  async (t) => {
    const { world, handle } = await integrated(t, { "a.txt": "base", "keep.txt": "keep" }, [
      build("build", { "a.txt": "new" }),
      review("r", "build"),
    ]);
    await chmod(join(world.repo, "a.txt"), 0o755);
    await assert.rejects(integrate(handle.dir), /conflicts/);
    await unlink(join(world.repo, "a.txt"));
    await symlink("keep.txt", join(world.repo, "a.txt"));
    await assert.rejects(integrate(handle.dir), /symlink/);
    assert.equal(await readFile(join(world.repo, "keep.txt"), "utf8"), "keep");
  },
);
