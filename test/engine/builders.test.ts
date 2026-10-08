import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentEvent, TaskSpec } from "../../engine/core/types.ts";
import { fauxWorld, type FauxTurn } from "./faux.ts";
import { spec } from "./helpers.ts";

const node = process.execPath;
const call = (name: string, args: Record<string, any>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const calls = (list: Array<[string, Record<string, any>]>) =>
  fauxAssistantMessage(
    list.map(([n, a]) => fauxToolCall(n, a)),
    { stopReason: "toolUse" },
  );

interface Scenario {
  write?: Record<string, string>;
  bash?: string;
  claim?: string[];
  silent?: boolean; // never submits in the first session
  verdict?: "approve" | "changes_requested";
}

function scenario(turn: FauxTurn): Scenario {
  const m = /# Task [a-z0-9-]+ \([a-z]+\)\n\n(\{[^\n]*\})/.exec(turn.text);
  return m ? JSON.parse(m[1]) : {};
}

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

// Builders write in round 0 and submit in round 1; reviewers submit their verdict at once.
function responder(turn: FauxTurn) {
  const s = scenario(turn);
  const resultOnly = turn.text.includes("did not produce a valid result");
  if (turn.role === "builder") {
    if (resultOnly) return submit({ changedFiles: s.claim ?? Object.keys(s.write ?? {}) });
    if (s.silent && turn.round > 0) return fauxAssistantMessage(fauxText("I made the change."));
    if (turn.round === 0) {
      const list: Array<[string, Record<string, any>]> = Object.entries(s.write ?? {}).map(
        ([path, content]) => ["write", { path, content }],
      );
      if (s.bash) list.push(["bash", { command: s.bash }]);
      return list.length ? calls(list) : submit({ changedFiles: [] });
    }
    return submit({ changedFiles: s.claim ?? Object.keys(s.write ?? {}) });
  }
  if (turn.role === "reviewer") {
    const verdict = turn.text.includes("prior approval is invalid")
      ? "approve"
      : (s.verdict ?? "approve");
    return submit({
      review: { verdict },
      findings:
        verdict === "approve"
          ? []
          : [{ severity: "high", message: "wrong value", evidence: "a.txt:1" }],
    });
  }
  return submit({ brief: "map" });
}

const builder = (id: string, s: Scenario, extra: Partial<TaskSpec> = {}) =>
  spec(id, "builder", {
    task: JSON.stringify(s),
    ownership: Object.keys(s.write ?? { "a.txt": "" }),
    checks: [{ id: "ok", argv: [node, "-e", "0"] }],
    ...extra,
  });
const reviewer = (id: string, of: string, s: Scenario = {}) =>
  spec(id, "reviewer", { task: JSON.stringify(s), reviewOf: of, after: [of] });

test("a builder works in a worktree, its checks run, and its reviewer sees the diff and binds the fingerprint", async (t) => {
  const world = await fauxWorld(t, responder, { files: { "a.txt": "old\n", "b.txt": "B\n" } });
  // The user's uncommitted work reaches the builder.
  await writeFile(join(world.repo, "b.txt"), "uncommitted\n");
  const events: AgentEvent[] = [];
  world.engine.onRun((r) => world.engine.subscribe(r.id, (e) => events.push(e)));
  const handle = await world.run(
    [builder("build", { write: { "a.txt": "new\n" } }), reviewer("review", "build")],
    { allowWrites: true },
  );
  const view = await handle.done;
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  const built = handle.results().get("build")!;
  const tree = (built.data as any).worktree;
  assert.equal(await readFile(join(tree, "a.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(tree, "b.txt"), "utf8"), "uncommitted\n");
  assert.equal(
    await readFile(join(world.repo, "a.txt"), "utf8"),
    "old\n",
    "the checkout is untouched",
  );
  assert.deepEqual(
    (built.data as any).changes.changes.map((c: any) => c.path),
    ["a.txt"],
  );
  assert.match(built.fingerprint!, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    events.filter((e) => e.t === "check_end").map((e: any) => [e.agent, e.check, e.passed]),
    [["build", "ok", true]],
  );
  const review = handle.results().get("review")!;
  assert.equal(review.result!.review!.fingerprint, built.fingerprint);
  assert.equal(review.result!.review!.taskId, "build");
  const brief = world.turns.find((x) => x.agent === "review")!.text;
  assert.match(brief, new RegExp(`"fingerprint":"${built.fingerprint}"`));
  const diffPath = /Diff: (\S+) /.exec(brief)![1];
  assert.match(await readFile(diffPath, "utf8"), /^\+new$/m);
  assert.equal(
    view.agents.review.workspace!.path,
    tree,
    "the reviewer reads the builder's worktree",
  );
});

test("verification catches writes outside ownership, false changedFiles and failed checks", async (t) => {
  const world = await fauxWorld(t, responder);
  const view = await (
    await world.run(
      [
        builder("sneaky", { write: { "a.txt": "x" }, bash: "echo x > other.txt" }),
        builder("liar", { write: { "c.txt": "y" }, claim: ["c.txt", "d.txt"] }),
        builder(
          "broken",
          { write: { "e.txt": "z" } },
          { checks: [{ id: "unit", argv: [node, "-e", "process.exit(2)"] }] },
        ),
      ],
      { allowWrites: true },
    )
  ).done;
  assert.equal(view.agents.sneaky.status, "failed");
  assert.match(view.agents.sneaky.reason!, /outside ownership: other\.txt/);
  assert.equal(view.agents.liar.status, "failed");
  assert.match(view.agents.liar.reason!, /differ from the actual changes/);
  assert.equal(view.agents.broken.status, "failed");
  assert.match(view.agents.broken.reason!, /Required check unit failed \(exit 2\)/);
  assert.equal(view.agents.broken.checks.unit.state, "failed");
});

test("a dependent builder starts from its predecessor's verified changes", async (t) => {
  const world = await fauxWorld(t, responder, { files: { "a.txt": "base\n" } });
  const handle = await world.run(
    [
      builder("first", { write: { "a.txt": "first\n", "f.txt": "f\n" } }),
      builder("second", { write: { "a.txt": "second\n" } }, { after: ["first"] }),
    ],
    { allowWrites: true },
  );
  const view = await handle.done;
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  const second = handle.results().get("second")!.data as any;
  assert.equal(await readFile(join(second.worktree, "f.txt"), "utf8"), "f\n");
  assert.deepEqual(
    second.changes.changes.map((c: any) => c.path),
    ["a.txt"],
  );
});

test("a builder that never reports gets one result-only attempt with write tools removed", async (t) => {
  const world = await fauxWorld(t, responder);
  const handle = await world.run(
    [
      builder(
        "quiet",
        { write: { "a.txt": "q" }, silent: true },
        { checks: [], noChecksReason: "fixture" },
      ),
    ],
    {
      allowWrites: true,
    },
  );
  const view = await handle.done;
  assert.equal(view.agents.quiet.status, "succeeded", JSON.stringify(view.agents.quiet));
  const resultOnly = world.turns.find((x) => x.text.includes("did not produce a valid result"))!;
  assert.deepEqual(resultOnly.tools, ["find", "grep", "ls", "read", "submit_result"]);
});

test("a rejected review is repaired: the builder re-runs with feedback and the reviewer re-reviews", async (t) => {
  let repaired = false;
  const world = await fauxWorld(t, (turn) => {
    if (turn.role === "builder" && turn.text.includes("Repair feedback")) {
      repaired = true;
      return turn.round === 0
        ? call("write", { path: "a.txt", content: "fixed\n" })
        : submit({ changedFiles: ["a.txt"] });
    }
    return responder(turn);
  });
  const handle = await world.run(
    [
      builder("build", { write: { "a.txt": "bug\n" } }),
      reviewer("review", "build", { verdict: "changes_requested" }),
    ],
    {
      allowWrites: true,
      limits: { repairs: 1 },
    },
  );
  let view = await handle.done;
  assert.equal(view.agents.review.status, "rejected");
  const before = handle.results().get("build")!.fingerprint;
  assert.deepEqual(world.engine.repair(handle.id, "build", "Use the fixed value"), [
    "build",
    "review",
  ]);
  view = await handle.done;
  assert(repaired);
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  const after = handle.results().get("build")!;
  assert.notEqual(after.fingerprint, before);
  assert.equal(handle.results().get("review")!.result!.review!.fingerprint, after.fingerprint);
  assert.equal(await readFile(join((after.data as any).worktree, "a.txt"), "utf8"), "fixed\n");
  assert.throws(
    () => world.engine.repair(handle.id, "build", "again"),
    /Repair budget|wait for it/,
  );
});

test("repairs refuse to replay completed downstream builders", async (t) => {
  const world = await fauxWorld(t, responder);
  const handle = await world.run(
    [
      builder("a", { write: { "a.txt": "1" } }),
      builder("b", { write: { "b.txt": "2" } }, { after: ["a"] }),
    ],
    { allowWrites: true },
  );
  await handle.done;
  assert.throws(
    () => world.engine.repair(handle.id, "a", "redo"),
    /Completed downstream work \(b\) needs a new run/,
  );
});

test("evidence checks run where a reader read and must not change it", async (t) => {
  const world = await fauxWorld(t, responder);
  const view = await (
    await world.run([
      spec("look", "scout", {
        evidenceChecks: [{ id: "count", argv: [node, "-e", "console.log(1)"] }],
      }),
      spec("touch", "scout", {
        evidenceChecks: [
          { id: "mutate", argv: [node, "-e", "require('fs').writeFileSync('new.txt', 'x')"] },
        ],
      }),
    ])
  ).done;
  assert.equal(view.agents.look.status, "succeeded");
  assert.equal(view.agents.touch.status, "failed");
  assert.match(view.agents.touch.reason!, /changed the files they inspected/);
});

test("a reviewer of uncommitted changes reviews the subject with its diff", async (t) => {
  const world = await fauxWorld(t, responder, { files: { "a.txt": "old\n" } });
  await writeFile(join(world.repo, "a.txt"), "wip\n");
  const handle = await world.run([spec("check", "reviewer", { reviewBase: "HEAD" })]);
  const view = await handle.done;
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  const brief = world.turns.find((x) => x.agent === "check")!.text;
  assert.match(brief, /"kind":"uncommitted"/);
  assert.match(brief, /Changed files: \[\{"status":"M","path":"a.txt"\}\]/);
  assert.equal(handle.results().get("check")!.result!.review!.taskId, null);
  await assert
    .rejects(
      world.run([spec("none", "reviewer", { reviewBase: "HEAD" })], {}).then(async (h) => {
        await writeFile(join(world.repo, "a.txt"), "old\n");
        return h;
      }),
      () => true,
    )
    .catch(() => {});
});

async function pullRequest(
  dir: string,
  repo: string,
  git: (...args: string[]) => string,
  headOverride?: string,
) {
  const main = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  const remote = join(dir, "github.com", "acme", "widget.git");
  await mkdir(join(dir, "github.com", "acme"), { recursive: true });
  git("init", "-q", "--bare", remote);
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", main);
  git("checkout", "-qb", "contributor");
  await writeFile(join(repo, "b.txt"), "from the pull request\n");
  git("add", "b.txt");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@e",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "PR change",
  );
  const head = git("rev-parse", "HEAD").trim();
  git("push", "-q", "origin", "HEAD:refs/pull/7/head");
  git("checkout", "-q", main);
  git("branch", "-qD", "contributor");
  const bin = join(dir, "bin");
  await mkdir(bin);
  const view = {
    number: 7,
    title: "Fix the widget",
    url: "https://github.com/acme/widget/pull/7",
    headRefOid: headOverride ?? head,
    baseRefName: main,
  };
  const fake = join(bin, "fake-gh.mjs");
  await writeFile(
    fake,
    `if (process.argv.slice(2, 5).join(" ") !== "pr view 7") process.exit(2);\nconsole.log(${JSON.stringify(JSON.stringify(view))});\n`,
  );
  if (process.platform === "win32")
    await writeFile(join(bin, "gh.cmd"), `@"${node}" "${fake}" %*\r\n`);
  else
    await writeFile(join(bin, "gh"), `#!/bin/sh\nexec "${node}" "${fake}" "$@"\n`, { mode: 0o755 });
  return { head, bin };
}

test("a pull request is fetched into a private ref and reviewed at its head", async (t) => {
  const world = await fauxWorld(t, responder, { files: { "b.txt": "original\n" } });
  const pr = await pullRequest(world.dir, world.repo, world.fixture.git);
  const PATH = process.env.PATH;
  process.env.PATH = `${pr.bin}${delimiter}${PATH}`;
  t.after(() => void (process.env.PATH = PATH));
  const handle = await world.run([spec("look", "reviewer", { reviewPr: 7 })]);
  const view = await handle.done;
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  const brief = world.turns.find((x) => x.agent === "look")!.text;
  assert.match(brief, /"kind":"pull-request"/);
  assert.match(brief, /Changed files: \[\{"status":"M","path":"b.txt"\}\]/);
  assert.equal(world.fixture.git("rev-parse", `refs/pinata/${handle.id}/pr-7`).trim(), pr.head);
  assert.equal(
    await readFile(join(view.agents.look.workspace!.path, "b.txt"), "utf8"),
    "from the pull request\n",
  );
  assert.equal(
    await readFile(join(world.repo, "b.txt"), "utf8"),
    "original\n",
    "the checkout never moves",
  );
});

test("a pull request whose head changed while fetching is refused and leaves no refs", async (t) => {
  const world = await fauxWorld(t, responder, { files: { "b.txt": "original\n" } });
  const pr = await pullRequest(world.dir, world.repo, world.fixture.git, "0".repeat(40));
  const PATH = process.env.PATH;
  process.env.PATH = `${pr.bin}${delimiter}${PATH}`;
  t.after(() => void (process.env.PATH = PATH));
  await assert.rejects(
    world.run([spec("look", "reviewer", { reviewPr: 7 })]),
    /changed while it was fetched/,
  );
  assert.equal(world.fixture.git("for-each-ref", "refs/pinata/"), "");
});
