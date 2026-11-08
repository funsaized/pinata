import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { setup } from "../../examples/relay/setup.mjs";

import { jobParams } from "../../engine/headless/main.ts";
import { discoverAgents, resolveTasks } from "../../engine/pi/definitions.ts";

import { headCommit } from "../../engine/workspace/snapshot.ts";
import { fauxWorld } from "./faux.ts";
import { tempDir } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../../examples/relay/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/relay", import.meta.url));
const node = (cwd: string, ...args: string[]) => {
  const env = { ...process.env };
  // Nested Node test runners must not inherit the parent's test-worker protocol.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
};

async function files(dir: string): Promise<Record<string, string>> {
  const names = await readdir(dir, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      names
        .filter(
          (f) =>
            f.isFile() &&
            !join(f.parentPath, f.name)
              .slice(dir.length + 1)
              .replaceAll("\\", "/")
              .startsWith(".git/"),
        )
        .map(async (f) => {
          const path = join(f.parentPath, f.name);
          return [path.slice(dir.length + 1).replaceAll("\\", "/"), await readFile(path, "utf8")];
        }),
    ),
  );
}

test("Relay setup creates a portable model-ready starter and refuses overwrites", async (t) => {
  const parent = await tempDir(t, "pinata-relay-");
  const dir = join(parent, "exercise with spaces");
  // macOS's temporary root is a symlink; CLI entry detection must resolve it.
  const linkedRoot = join(parent, "linked example");
  await symlink(ROOT, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const setupScript = join(linkedRoot, "setup.mjs");
  const created = node(ROOT, setupScript, dir);
  assert.equal(created.status, 0, created.stderr);
  const unfinished = node(dir, "bin/relay.mjs", "data/events.jsonl");
  assert.equal(unfinished.status, 1);
  assert.match(unfinished.stderr, /Not implemented/);
  assert.equal(node(dir, "verify.mjs").status, 1);
  const file = join(dir, "src", "summarize.mjs");
  const edited = "// User work must survive another setup attempt.\n";
  await writeFile(file, edited);
  await assert.rejects(setup(dir), { code: "EEXIST" });
  assert.equal(await readFile(file, "utf8"), edited);
  assert.equal(node(ROOT, setupScript, dir, "--finished").status, 1);
  const job = JSON.parse(await readFile(join(dir, "job.json"), "utf8"));
  assert.equal(jobParams(job, join(dir, "job.json")).cwd, dir);
  assert.equal(job.config.worktreeRoot, undefined);
  assert.equal(job.background, undefined);
  for (const role of ["scout", "builder", "reviewer"])
    assert.equal(job.config.models[role].provider, "REPLACE_WITH_APPROVED_PROVIDER");
});

function responsibility(id: string): string[] {
  const component = id.replace("build-", "");
  if (!id.startsWith("build-")) return [];
  return [
    component === "cli" ? "bin/relay.mjs" : `src/${component}.mjs`,
    `test/${component}.test.mjs`,
  ];
}

async function runRelay(t: TestContext, overrides: Record<string, string> = {}) {
  // Exercise the same generated starter as the tutorial, including its acceptance check.
  const source = join(await tempDir(t, "pinata-relay-proof-"), "starter");
  await setup(source);
  const starter = await files(source);
  const finished = { ...(await files(FIXTURE)), ...overrides };
  const job = JSON.parse(starter["job.json"]);
  const resolved = resolveTasks(
    job.tasks,
    discoverAgents(undefined, join(ROOT, "absent-agent-dir")),
  );
  const tasks = resolved.tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const world = await fauxWorld(
    t,
    (turn) => {
      const task = byId.get(turn.agent!)!;
      if (turn.role === "builder" && turn.round === 0)
        return fauxAssistantMessage(
          responsibility(task.id).map((path) =>
            fauxToolCall("write", { path, content: finished[path] }),
          ),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(
        [
          fauxToolCall("submit_result", {
            status: "succeeded",
            summary: "Scripted fixture response; no live model evaluation.",
            changedFiles: turn.role === "builder" ? responsibility(task.id) : [],
            checks: [],
            findings: [],
            blockers: [],
            ...(turn.role === "reviewer"
              ? { review: { verdict: "approve" } }
              : {
                  brief:
                    "Read REQUIREMENTS.md; preserve module contracts and verify the destination.",
                }),
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    { files: starter },
  );
  const head = await headCommit(world.repo);
  const handle = await world.run(tasks, {
    allowWrites: true,
    data: { definitions: resolved.definitions },
  });
  return { world, handle, head, tasks, view: await handle.done };
}

test("Relay shared delegation delivers code for ordinary coordinator checks", async (t) => {
  const { world, head, view } = await runRelay(t);
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  assert.equal(node(world.repo, "verify.mjs").status, 0);
  assert.equal(node(world.repo, "--test").status, 0);
  assert.equal(await headCommit(world.repo), head);
  assert.equal(world.fixture.git("diff", "--cached", "--name-only"), "");
});
test("a wrong check or implementation stays visible for coordinator correction", async (t) => {
  const { world, view } = await runRelay(t, { "bin/relay.mjs": 'console.log("wrong report");\n' });
  assert.equal(view.status, "succeeded", "execution returns control independently of correctness");
  assert.notEqual(node(world.repo, "verify.mjs").status, 0);
  assert.match(await readFile(join(world.repo, "bin/relay.mjs"), "utf8"), /wrong report/);
});
