import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxWorld } from "./faux.ts";
import { spec, tempDir } from "./helpers.ts";
import { runsRoot, replay } from "../../engine/core/store.ts";
import { PinataHost } from "../../engine/pi/host.ts";
const response = (text: string) => fauxAssistantMessage([fauxText(text)]);
test("shared builders preserve user edits and need no ownership, reports or check ceremony", async (t) => {
  const world = await fauxWorld(t, (turn) =>
    turn.round === 0
      ? fauxAssistantMessage(
          [fauxToolCall("write", { path: "feature.txt", content: "implementation" })],
          { stopReason: "toolUse" },
        )
      : response("Implemented. A proposed test was wrong; inspect it."),
  );
  await writeFile(join(world.repo, "user.txt"), "user edit");
  const handle = await world.run([spec("build", "builder")], { allowWrites: true });
  assert.equal((await handle.done).status, "succeeded");
  assert.equal(handle.view().agents.build.workspace?.path, world.repo);
  assert.equal(await readFile(join(world.repo, "user.txt"), "utf8"), "user edit");
  assert.equal(await readFile(join(world.repo, "feature.txt"), "utf8"), "implementation");
  assert.equal(world.turns.length, 2, "no result-only retry");
  assert.match(handle.results().get("build")!.summary, /proposed test was wrong/);
});
test("an isolated worker retains its frozen workspace and context through a follow-up", async (t) => {
  const world = await fauxWorld(t, (turn) =>
    turn.round === 0
      ? fauxAssistantMessage([fauxToolCall("write", { path: "feature.txt", content: "first" })], {
          stopReason: "toolUse",
        })
      : response("Saved first implementation"),
  );
  const handle = await world.run([spec("build", "builder", { workspace: "worktree" })], {
    allowWrites: true,
  });
  await handle.done;
  const first = handle.view().agents.build.workspace!.path;
  await writeFile(join(world.repo, "later.txt"), "shared only");
  await world.engine.steer(handle.id, "build", "Continue in the original context", "followUp");
  await handle.done;
  assert.equal(handle.view().agents.build.workspace!.path, first);
  assert.match(world.turns.at(-1)!.text, /Saved first implementation/);
  await assert.rejects(readFile(join(first, "later.txt")), /ENOENT/);
  assert(handle.results().get("build")?.data?.changes);
});
test("Pi host starts and reattaches shared writers in a non-Git directory", async (t) => {
  const world = await fauxWorld(t, () => response("Non-Git assignment done"));
  const root = await tempDir(t, "pinata-non-git-");
  await mkdir(join(root, "nested"));
  const pi = {
    getThinkingLevel: () => "off",
    getSettings: () => ({}),
    getAllTools: () => [],
  } as never;
  const host = new PinataHost(pi);
  t.after(() => host.shutdown("done"));
  const ctx = {
    cwd: root,
    modelRegistry: world.registry,
    model: world.registry.find("faux", "faux-1"),
  } as never;
  const { handle } = await host.start(
    {
      tasks: [
        spec("build", "builder", { model: { provider: "faux", id: "faux-1", thinking: "off" } }),
      ],
      config: { models: { default: { provider: "faux", id: "faux-1", thinking: "off" } } },
    },
    ctx,
  );
  await handle.done;
  assert.equal(await runsRoot(root), join(root, ".pinata", "runs"));
  assert.equal((await host.find(handle.id, root)).id, handle.id);
  assert.equal((await replay(handle.dir)).agents.build.workspace?.path, root);
  await assert.rejects(readFile(join(root, ".git")), /ENOENT/);
});

test("failed worktree provisioning exposes its partial snapshot without a model call", async (t) => {
  const world = await fauxWorld(t, () => response("should not start"));
  const script =
    "require('node:fs').writeFileSync('partial.txt','useful partial preparation'); process.exit(1)";
  const handle = await world.run([spec("build", "builder", { workspace: "worktree" })], {
    allowWrites: true,
    config: { setup: `node -e "${script}"` },
  });
  await handle.done;
  assert.equal(handle.view().agents.build.status, "failed");
  assert.equal(world.turns.length, 0);
  const changes = handle.results().get("build")?.data?.changes as {
    changes: Array<{ path: string }>;
  };
  assert(changes.changes.some((change) => change.path === "partial.txt"));
  assert.match(handle.results().get("build")!.summary, /Setup failed/);
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
    await writeFile(join(bin, "gh.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
  else
    await writeFile(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, {
      mode: 0o755,
    });
  return { head, bin };
}

test("an explicitly isolated PR reviewer reads the fetched head and retains it on continuation", async (t) => {
  const world = await fauxWorld(t, () => response("Reviewed the saved PR snapshot"), {
    files: { "b.txt": "original\n" },
  });
  const pr = await pullRequest(world.dir, world.repo, world.fixture.git);
  const priorPath = process.env.PATH;
  process.env.PATH = `${pr.bin}${delimiter}${priorPath}`;
  t.after(() => {
    process.env.PATH = priorPath;
  });
  const handle = await world.run([
    spec("review", "reviewer", { reviewPr: 7, workspace: "worktree" }),
  ]);
  await handle.done;
  assert.equal(
    handle.view().agents.review.status,
    "succeeded",
    handle.results().get("review")?.summary,
  );
  const path = handle.view().agents.review.workspace!.path;
  assert.equal(await readFile(join(path, "b.txt"), "utf8"), "from the pull request\n");
  assert.equal(await readFile(join(world.repo, "b.txt"), "utf8"), "original\n");
  assert.match(world.turns[0].text, /"kind":"pull-request"/);
  await world.engine.steer(handle.id, "review", "Continue the same review", "followUp");
  await handle.done;
  assert.equal(handle.view().agents.review.workspace!.path, path);
  assert.match(world.turns.at(-1)!.text, new RegExp(pr.head));
});

test("local review receives its saved uncommitted diff and reports an empty subject as preparation failure", async (t) => {
  const world = await fauxWorld(t, () => response("Reviewed the diff"), {
    files: { "a.txt": "original\n" },
  });
  await writeFile(join(world.repo, "a.txt"), "uncommitted\n");
  const handle = await world.run([spec("review", "reviewer", { reviewBase: "HEAD" })]);
  await handle.done;
  assert.equal(handle.view().agents.review.status, "succeeded");
  assert.match(world.turns[0].text, /"kind":"uncommitted"/);
  await writeFile(join(world.repo, "a.txt"), "original\n");
  const empty = await world.run([spec("empty", "reviewer", { reviewBase: "HEAD" })]);
  await empty.done;
  assert.equal(empty.view().agents.empty.status, "failed");
  assert.match(empty.results().get("empty")!.summary, /Nothing to review/);
});

test("cancellation interrupts an occupied dependency-cache wait without stealing the lock", async (t) => {
  const world = await fauxWorld(t, () => response("unused"), {
    files: {
      ".gitignore": "node_modules/\n",
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
      "package-lock.json": JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "fixture", version: "1.0.0" } },
      }),
    },
  });
  const { resolveSetup, dependencyKey, provision } =
    await import("../../engine/workspace/dependencies.ts");
  const { environment } = await import("../../engine/verify/checks.ts");
  const setup = await resolveSetup(
    undefined,
    world.repo,
    world.fixture.git("rev-parse", "HEAD").trim(),
  );
  const key = await dependencyKey(world.repo, setup, environment([], { PINATA_ROOT: world.repo }));
  assert(key);
  const cacheRoot = join(world.dir, "cache");
  await mkdir(cacheRoot);
  const lock = join(cacheRoot, `${key}.lock`);
  await writeFile(lock, "occupied");
  const controller = new AbortController();
  controller.abort(new Error("stop dependency preparation"));
  await assert.rejects(
    provision({
      worktree: world.repo,
      baseTree: world.fixture.git("rev-parse", "HEAD^{tree}").trim(),
      setup,
      cacheRoot,
      markerDir: join(world.dir, "markers"),
      task: "build",
      root: world.repo,
      passEnv: [],
      logDir: join(world.dir, "logs"),
      signal: controller.signal,
    }),
    /stop dependency preparation/,
  );
  assert.equal(await readFile(lock, "utf8"), "occupied");
});
