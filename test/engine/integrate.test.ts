import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Check, TaskSpec } from "../../engine/core/types.ts";
import { validateGraph } from "../../engine/core/validate.ts";
import { integrate, rollback, writeRunRecord } from "../../engine/verify/integrate.ts";
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
        Object.entries<string>(s.write ?? {}).map(([path, content]) =>
          fauxToolCall("write", { path, content }),
        ),
        { stopReason: "toolUse" },
      );
    return submit({ changedFiles: Object.keys(s.write ?? {}) });
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
    tasks: validateGraph(tasks, { allowWrites: true }),
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
  await assert.rejects(
    integrate(rejected.handle.dir),
    /Every task must succeed .*review is rejected/,
  );
  const unreviewed = await integrated(t, { "a.txt": "a" }, [build("build", { "a.txt": "b" })]);
  await assert.rejects(integrate(unreviewed.handle.dir), /Independent review required for build/);
});

test("integration refuses a moved HEAD, files edited since the run started, and secret files", async (t) => {
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
  await assert.rejects(integrate(moved.handle.dir), /HEAD moved/);
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
    tasks: validateGraph(tasks, { allowWrites: true }),
    allowWrites: true,
    integratedChecks: [],
    noIntegratedChecksReason: "fixture",
    passEnv: [],
    taskMs: 60_000,
  });
  await handle.done;
  assert.equal((await integrate(handle.dir)).status, "verified");
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "first\n");
  world.engine.repair(handle.id, "build", "a.txt must say fixed");
  const view = await handle.done;
  assert(fixed);
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  assert.equal((await integrate(handle.dir)).status, "verified");
  assert.equal(await readFile(join(world.repo, "a.txt"), "utf8"), "fixed\n");
  assert.equal(await readFile(join(world.repo, "extra.txt"), "utf8"), "extra\n");
});

test("integration works through paths with spaces, quotes and Unicode", async (t) => {
  const file = process.platform === "win32" ? "new ' 雨 file.txt" : "new ' 雨\nfile.txt";
  const { world, handle } = await integrated(t, { "a.txt": "a" }, [
    build("build", { [file]: "value" }),
    review("review", "build"),
  ]);
  assert.equal((await integrate(handle.dir)).status, "verified");
  assert.equal(await readFile(join(world.repo, file), "utf8"), "value");
});
