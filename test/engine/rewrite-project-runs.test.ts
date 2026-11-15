import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { projectRuns } from "../../engine/sources/project.ts";
import { DurableStore } from "../../engine/storage/index.ts";
import { discoverWorkspaceStore } from "../../engine/workspace/location.ts";
import { UiSource, uiState } from "./rewrite-ui-fixture.ts";

async function temporary(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pinata-project-runs-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}
async function save(workspace: string, run: string, custom?: string): Promise<string> {
  const directory = custom ?? join((await discoverWorkspaceStore(workspace)).store, run);
  const store = await DurableStore.open({
    directory,
    manifest: {
      schemaVersion: 1,
      run,
      workspace,
      store: directory,
      createdAt: "2026-11-15T00:00:00.000Z",
    },
  });
  await store.close();
  return directory;
}

test("project runs include sibling worktrees and matching bound custom stores, excluding other repositories", async (t) => {
  const root = await temporary(t);
  const first = join(root, "first");
  const second = join(root, "second");
  const sibling = join(root, "sibling");
  const git = (cwd: string, args: string[]) => promisify(execFile)("git", args, { cwd });
  for (const directory of [first, second]) {
    await mkdir(directory);
    await git(directory, ["init"]);
    await git(directory, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
  }
  await git(first, ["worktree", "add", "--detach", sibling]);
  const primary = await save(first, "first-run");
  await save(sibling, "sibling-run");
  const unrelated = await save(second, "second-run");
  const custom = await save(first, "custom-run", join(root, "custom"));
  const live = Object.assign(new UiSource({ ...uiState(0), run: "custom-run" }), {
    location: { workspace: first, directory: custom },
  });
  const foreign = Object.assign(new UiSource({ ...uiState(0), run: "second-run" }), {
    location: { workspace: second, directory: unrelated },
  });
  const catalog = projectRuns(sibling, () => [live, foreign]);
  const before = await readFile(join(primary, "run.json"));
  const listed = await catalog.list();
  assert.deepEqual(listed.runs.map((entry) => entry.run).sort(), [
    "custom-run",
    "first-run",
    "sibling-run",
  ]);
  assert.equal(listed.skipped, 0);
  const bound = listed.runs.find((entry) => entry.run === live.run);
  const retained = listed.runs.find((entry) => entry.run === "first-run");
  assert(bound && retained);
  assert.equal(await catalog.open(bound), live);
  const saved = await catalog.open(retained);
  assert.equal(saved.capabilities.control, false);
  assert.equal(saved.capabilities.recover, false);
  assert.equal(saved.capabilities.live, false);
  assert.deepEqual(await readFile(join(primary, "run.json")), before);
  assert.deepEqual(await saved.request({ method: "recover", input: {} }), {
    status: "error",
    error: {
      code: "unsupported",
      message:
        "Saved run sources cannot wait, recover or acknowledge notifications; use Pi tools or an embedded owning runtime",
    },
  });
  assert.equal(live.calls.length, 0);
  assert.equal(foreign.calls.length, 0);
  await assert.rejects(
    catalog.open({
      run: "second-run",
      directory: unrelated,
      workspace: second,
      live: false,
      control: false,
    }),
    /no longer belongs/,
  );
});

test("non-Git discovery validates manifests and skips unreadable evidence without opening ownership", async (t) => {
  const root = await temporary(t);
  const first = join(root, "first");
  const other = join(root, "other");
  await mkdir(first);
  await mkdir(other);
  const directory = await save(first, "saved-run");
  const foreign = await save(other, "foreign", join(first, ".pinata/runs/foreign"));
  const broken = join(first, ".pinata/runs/broken");
  await mkdir(broken);
  await writeFile(join(broken, "run.json"), "invalid");
  const catalog = projectRuns(first, () => []);
  const listed = await catalog.list();
  assert.deepEqual(
    listed.runs.map((entry) => entry.directory),
    [directory],
  );
  assert.equal(listed.skipped, 1);
  const saved = await catalog.open(listed.runs[0]);
  assert.equal(await catalog.open(listed.runs[0]), saved);
  const manifest = JSON.parse(await readFile(join(directory, "run.json"), "utf8"));
  await writeFile(join(directory, "run.json"), JSON.stringify({ ...manifest, workspace: other }));
  await assert.rejects(catalog.open(listed.runs[0]), /no longer belongs/);
  assert.equal((await projectRuns(other, () => []).list()).runs.length, 0);
  assert(foreign.startsWith(first));
});
