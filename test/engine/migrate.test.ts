// Upgrading a repository with 0.7.0 runs (E9.2): GC retires them with 0.7.0's rules, keeps
// their artifacts, and never touches engine runs or anything still in use.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { retireLegacy } from "../../engine/migrate/legacy.ts";
import { validateConfig } from "../../engine/pi/config.ts";
import { gitRepo } from "./faux.ts";
import { tempDir } from "./helpers.ts";

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

test("0.7.0 runs are retired with 0.7.0's GC rules; artifacts and engine runs are kept", async (t) => {
  const dir = await tempDir(t);
  const repo = join(dir, "repo");
  const fixture = gitRepo(repo, { "a.txt": "old\n" });
  await fixture.init();
  const root = join(repo, ".git", "pinata");
  const legacy = async (
    n: number,
    tasks: Array<{ role: string; status: string; tree?: boolean }>,
    extra: Record<string, unknown> = {},
  ) => {
    const run = join(root, id(n));
    await mkdir(run, { recursive: true });
    const manifest = {
      id: id(n),
      cwd: repo,
      tasks: await Promise.all(
        tasks.map(async (task, i) => {
          const worktree = join(run, "worktrees", `t${i}`);
          if (task.tree) fixture.git("worktree", "add", "-q", "--detach", worktree);
          return {
            spec: { id: `t${i}`, role: task.role },
            status: task.status,
            ...(task.tree && { worktree }),
            attempts: [],
          };
        }),
      ),
      ...extra,
    };
    await writeFile(join(run, "manifest.json"), JSON.stringify(manifest));
    return { run, worktree: join(run, "worktrees", "t0") };
  };
  const clean = await legacy(1, [{ role: "scout", status: "succeeded", tree: true }]);
  const integrated = await legacy(2, [{ role: "builder", status: "succeeded", tree: true }], {
    integration: { status: "verified" },
  });
  await writeFile(join(integrated.worktree, "a.txt"), "new\n");
  await writeFile(join(repo, "a.txt"), "new\n"); // integrated into the checkout
  const unintegrated = await legacy(3, [{ role: "builder", status: "succeeded", tree: true }]);
  await writeFile(join(unintegrated.worktree, "a.txt"), "unmerged\n");
  const active = await legacy(4, [{ role: "scout", status: "running" }]);
  const locked = await legacy(5, [{ role: "scout", status: "succeeded" }]);
  await writeFile(join(locked.run, "coordinator.lock"), "{}");
  const coordinated = await legacy(6, [{ role: "scout", status: "succeeded" }], {
    background: { runner: { pid: process.pid } },
  });
  // An engine run is not 0.7.0's.
  await mkdir(join(root, id(7)), { recursive: true });
  await writeFile(join(root, id(7), "events.jsonl"), "");
  await writeFile(join(root, id(7), "manifest.json"), "{}");

  const preview = await retireLegacy(root);
  const actions = (n: number) => preview.filter((i) => i.run === id(n)).map((i) => i.action);
  assert.deepEqual(actions(1), ["would remove", "would retire"]);
  assert.deepEqual(actions(2), ["would remove", "would retire"]);
  assert.deepEqual(actions(3), ["retained"]);
  assert.match(preview.find((i) => i.run === id(3))!.reason!, /never integrated/);
  assert.match(preview.find((i) => i.run === id(4))!.reason!, /active or uncertain/);
  assert.match(preview.find((i) => i.run === id(5))!.reason!, /locked/);
  assert.match(preview.find((i) => i.run === id(6))!.reason!, /coordinator is still running/);
  assert(!preview.some((i) => i.run === id(7)), "engine runs are never listed");
  assert(existsSync(clean.worktree), "a preview changes nothing");

  const done = await retireLegacy(root, { confirm: true });
  assert(done.some((i) => i.run === id(1) && i.action === "retired"));
  assert(!existsSync(clean.worktree) && !existsSync(integrated.worktree));
  assert(existsSync(unintegrated.worktree), "unintegrated work is kept");
  assert(existsSync(join(clean.run, "manifest.json")), "artifacts are kept");
  const retired = JSON.parse(await readFile(join(clean.run, "retired.json"), "utf8"));
  assert(retired.report.some((i: { action: string }) => i.action === "removed"));
  assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "new\n", "the checkout is untouched");
  const again = await retireLegacy(root);
  assert(!again.some((i) => i.run === id(1) || i.run === id(2)), "retired runs stay retired");
  void active;
});

test("0.7.0 config keys that no longer apply produce a one-line notice", () => {
  const { notices } = validateConfig({ herdr: "/usr/bin/herdr" });
  assert.equal(notices.length, 1);
  assert(!notices[0].includes("\n"));
});
