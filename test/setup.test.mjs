import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { command, readJson, exists } from "../lib/core.mjs";
import { config, repair, cleanup, add, integrate } from "../lib/pinata.mjs";
import { resolveSetup } from "../lib/workspace.mjs";
import { fixture, task, settled, repository } from "./helpers.mjs";

const builder = (scenario = {}, extra = {}) =>
  task("build", "builder", scenario, {
    ownership: ["a.txt"],
    noChecksReason: "Direct fixture assertions",
    ...extra,
  });
const review = () =>
  task("review", "reviewer", { rejectBad: true }, { after: ["build"], reviewOf: "build" });
const attempt = (f, name, n = 1) => path.join(f.run, "tasks", name, String(n));

async function commitFiles(cwd, files) {
  if (!Object.keys(files).length) return;
  for (const [file, data] of Object.entries(files)) await fs.writeFile(path.join(cwd, file), data);
  for (const args of [
    ["add", "--", ...Object.keys(files)],
    ["-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-qm", "lockfiles"],
  ]) {
    const r = await command(["git", "-C", cwd, ...args]);
    if (r.code) throw new Error(r.stderr);
  }
}

// Runs detection with PATH limited to fake package managers.
async function detect(t, files, managers = []) {
  const repo = await repository("pinata-setup-");
  t.after(() => fs.rm(repo.dir, { recursive: true, force: true }));
  await commitFiles(repo.cwd, files);
  const bin = path.join(repo.dir, "bin");
  await fs.mkdir(bin);
  for (const name of managers)
    await fs.writeFile(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  const git = (await command(["sh", "-c", "command -v git"])).stdout.trim();
  await fs.symlink(git, path.join(bin, "git"));
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    return await resolveSetup(undefined, repo.cwd, "HEAD");
  } finally {
    process.env.PATH = oldPath;
  }
}

test("setup detection picks one strict install per ecosystem from committed root lockfiles", async (t) => {
  assert.deepEqual(await detect(t, { "package-lock.json": "{}" }, ["npm"]), {
    command: "npm ci --prefer-offline --no-audit --no-fund",
    source: "detected",
    lockfiles: ["package-lock.json"],
  });
  assert.equal(
    (await detect(t, { "yarn.lock": "", ".yarnrc.yml": "" }, ["yarn"])).command,
    "yarn install --immutable",
  );
  assert.equal(
    (await detect(t, { "pnpm-lock.yaml": "", "uv.lock": "" }, ["pnpm", "uv"])).command,
    "pnpm install --frozen-lockfile --prefer-offline && uv sync --frozen",
  );
  const conflict = await detect(t, { "package-lock.json": "{}", "yarn.lock": "" }, ["npm", "yarn"]);
  assert.equal(conflict.command, null);
  assert.match(conflict.reason, /Conflicting lockfiles/);
  const missing = await detect(t, { "pnpm-lock.yaml": "" });
  assert.equal(missing.command, null);
  assert.match(missing.reason, /pnpm, which is not on PATH/);
  assert.equal((await detect(t, {})).reason, "No root lockfile detected");
  assert.deepEqual(await resolveSetup(false, "/unused", "HEAD"), {
    command: null,
    source: "disabled",
  });
  assert.deepEqual(await resolveSetup("make deps", "/unused", "HEAD"), {
    command: "make deps",
    source: "config",
  });
  assert.throws(() => config({ setup: "  " }), /setup must be/);
  assert.throws(() => config({ codemode: "yes" }), /codemode must be/);
});

test("setup runs once per builder worktree before Pi, with PINATA_ROOT, and repairs reuse it", async (t) => {
  const f = await fixture(
    t,
    [builder({ write: { "a.txt": "bad" }, repair: "fixed" }), review(), task("look", "scout")],
    {
      config: {
        setup:
          'mkdir -p ignored && echo run >> ignored/count.txt && printf %s "$PINATA_ROOT" > ignored/root.txt',
      },
    },
  );
  assert.equal((await f.manifest()).setup.source, "config");
  const first = await settled(f);
  assert.equal(first.tasks.find((x) => x.id === "review").status, "rejected");
  const tree = path.join(f.run, "worktrees", "build");
  assert.equal(
    await fs.readFile(path.join(tree, "ignored/root.txt"), "utf8"),
    await fs.realpath(f.cwd),
  );
  assert.equal((await readJson(path.join(attempt(f, "build"), "outcome.json"))).setup.code, 0);
  assert(!(await exists(path.join(attempt(f, "look"), "setup.stdout.log"))), "scouts skip setup");
  assert.equal((await readJson(path.join(attempt(f, "review"), "task.json"))).setup, null);
  await repair(f.run, "build", "Use the accepted value");
  const second = await settled(f);
  assert(
    second.tasks.every((x) => x.status === "succeeded"),
    JSON.stringify(second),
  );
  assert.equal(await fs.readFile(path.join(tree, "ignored/count.txt"), "utf8"), "run\n");
  assert.equal(
    (await readJson(path.join(attempt(f, "build", 2), "outcome.json"))).setup.skipped,
    true,
  );
});

test("inspection-only runs skip setup without overrides; adding a builder resolves it", async (t) => {
  const command = "mkdir -p ignored && echo ready > ignored/setup-marker";
  const f = await fixture(
    t,
    [task("look", "scout"), task("plan", "planner"), task("search", "research")],
    {
      config: {
        setup: command,
        webExtension: new URL("./fixtures/pi.mjs", import.meta.url).pathname,
      },
    },
  );
  assert.equal((await f.manifest()).setup.source, "not-needed");
  assert.equal((await f.manifest()).setup.command, null);
  assert.equal((await f.manifest()).config.setup, command, "builder configuration is preserved");
  assert((await settled(f)).tasks.every((task) => task.status === "succeeded"));
  for (const id of ["look", "plan", "search"]) {
    assert.equal((await readJson(path.join(attempt(f, id), "task.json"))).setup, null);
    assert(!(await exists(path.join(attempt(f, id), "setup.stdout.log"))));
  }
  const added = await add(f.run, [builder(), review()]);
  assert.equal(added.setup.source, "config");
  assert.equal(added.setup.command, command);
  assert((await settled(f)).tasks.every((task) => task.status === "succeeded"));
  assert.equal(
    await fs.readFile(path.join(f.run, "worktrees/build/ignored/setup-marker"), "utf8"),
    "ready\n",
  );
});

test("setup failure has its own retry budget and never consumes repairs", async (t) => {
  const f = await fixture(t, [builder({ write: { "a.txt": "A" } })], {
    config: { setup: "test -f ignored/once || { mkdir -p ignored; touch ignored/once; exit 3; }" },
  });
  const failed = await settled(f).catch(() => null);
  const outcome = await readJson(path.join(attempt(f, "build"), "outcome.json"));
  assert.equal(outcome.status, "failed", JSON.stringify(failed));
  assert.equal(outcome.failureStage, "setup");
  assert.match(outcome.error, /Setup failed \(exit 3\)/);
  assert.equal(outcome.setup.code, 3);
  await repair(f.run, "build", "Transient setup failure; retry");
  assert.equal((await settled(f)).tasks[0].status, "succeeded");
  const manifest = await f.manifest();
  assert.equal(manifest.tasks[0].repairs, 0);
  assert.equal(manifest.tasks[0].setupRetries, 1);
});

test("a failed repair after skipped setup is failed rather than falsely uncertain", async (t) => {
  const f = await fixture(t, [builder({ noResult: true })], {
    config: { setup: "mkdir -p ignored" },
  });
  assert.equal((await settled(f)).tasks[0].status, "failed");
  await repair(f.run, "build", "Retry the report");
  assert.equal((await settled(f)).tasks[0].status, "failed");
  const result = await readJson(path.join(attempt(f, "build", 2), "outcome.json"));
  assert.equal(result.setup.skipped, true);
  assert.equal(result.setup.terminated, true);
});

test("setup that changes project files fails and cannot be retried in place", async (t) => {
  const f = await fixture(t, [builder({ write: { "a.txt": "A" } })], {
    config: { setup: "echo changed > b.txt" },
  });
  await settled(f).catch(() => null);
  const outcome = await readJson(path.join(attempt(f, "build"), "outcome.json"));
  assert.equal(outcome.failureStage, "setup");
  assert.match(outcome.error, /Setup changed project files/);
  await assert.rejects(repair(f.run, "build", "retry"), /Setup modified project files/);
});

test("builder cleanup requires integration; ignored dependencies do not prevent verified retirement", async (t) => {
  const f = await fixture(t, [builder(), review()], {
    config: {
      setup: "mkdir -p ignored/node_modules/pkg && echo x > ignored/node_modules/pkg/index.js",
    },
  });
  assert.equal((await settled(f)).tasks[0].status, "succeeded");
  const report = await cleanup(f.run, true);
  assert(
    report.report.some((r) => /integration is not verified/.test(r.reason)),
    JSON.stringify(report),
  );
  assert(await exists(path.join(f.run, "worktrees", "build")));
  assert.equal((await integrate(f.run)).integration.status, "verified");
  assert(!(await exists(path.join(f.run, "worktrees", "build"))));
});

test("workers get codemode, a private TMPDIR, and the codemode brief unless disabled", async (t) => {
  const on = await fixture(t, [task("look", "scout")]);
  await settled(on);
  const args = await readJson(path.join(attempt(on, "look"), "args.json"));
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,codemode");
  assert.equal(args[args.indexOf("--extension") + 1], "builtin:codemode");
  assert.equal(
    await fs.readFile(path.join(attempt(on, "look"), "tmpdir.txt"), "utf8"),
    path.join(attempt(on, "look"), "tmp"),
  );
  assert.match(await fs.readFile(path.join(attempt(on, "look"), "context.md"), "utf8"), /codemode/);
  const off = await fixture(t, [task("look", "scout")], { config: { codemode: false } });
  await settled(off);
  const plain = await readJson(path.join(attempt(off, "look"), "args.json"));
  assert.equal(plain[plain.indexOf("--tools") + 1], "read,grep,find,ls");
  assert(!plain.includes("builtin:codemode"));
});

test("the tool call budget stops a worker that keeps calling tools", async (t) => {
  const f = await fixture(t, [task("look", "scout", { toolCalls: 5, hang: true })], {
    config: { limits: { startupMs: 2500, taskMs: 15_000, jobMs: 120_000, maxToolCalls: 2 } },
  });
  await settled(f).catch(() => null);
  const outcome = await readJson(path.join(attempt(f, "look"), "outcome.json"));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /tool call budget exceeded/);
});
