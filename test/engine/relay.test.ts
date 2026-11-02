import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { setup } from "../../examples/relay/setup.mjs";
import { taskSpec } from "../../engine/core/definitions.ts";
import { validateGraph } from "../../engine/core/validate.ts";
import { jobParams } from "../../engine/headless/main.ts";
import { discoverAgents, resolveTasks } from "../../engine/pi/definitions.ts";
import { integrate, writeRunRecord } from "../../engine/verify/integrate.ts";
import { headCommit } from "../../engine/workspace/snapshot.ts";
import { fauxWorld } from "./faux.ts";
import { tempDir } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../../examples/relay/", import.meta.url));
const json = async (file: string) => JSON.parse(await readFile(join(ROOT, file), "utf8"));
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
        .filter((f) => f.isFile())
        .map(async (f) => {
          const path = join(f.parentPath, f.name);
          return [path.slice(dir.length + 1).replaceAll("\\", "/"), await readFile(path, "utf8")];
        }),
    ),
  );
}

test("Relay offline lesson is portable, catches the deliberate fault, and refuses overwrites", async (t) => {
  const dir = join(await tempDir(t, "pinata-relay-"), "exercise with spaces");
  const setupScript = join(ROOT, "setup.mjs");
  const created = node(ROOT, setupScript, dir, "--finished");
  assert.equal(created.status, 0, created.stderr);
  const checked = node(dir, "--test", "--test-reporter=tap");
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /# tests 23/);
  assert.equal(node(dir, "verify.mjs").status, 0);
  const file = join(dir, "src", "summarize.mjs");
  const correct = await readFile(file, "utf8");
  await writeFile(file, correct.replace("event.status >= 500", "event.status > 500"));
  assert.equal(node(dir, "--test", "test/summarize.test.mjs").status, 1);
  await writeFile(file, correct);
  assert.equal(node(dir, "--test", "test/summarize.test.mjs").status, 0);
  assert.equal(node(dir, "verify.mjs").status, 0);
  await assert.rejects(setup(dir), { code: "EEXIST" });
  assert.equal(await readFile(file, "utf8"), correct);
  const job = JSON.parse(await readFile(join(dir, "job.json"), "utf8"));
  assert.equal(jobParams(job, join(dir, "job.json")).cwd, dir);
  assert.equal(job.config.worktreeRoot, undefined);
  assert.equal(job.background, undefined);
  for (const role of ["scout", "builder", "reviewer"])
    assert.equal(job.config.models[role].provider, "REPLACE_WITH_APPROVED_PROVIDER");
});

test("Relay fixtures match provenance and recorded reviews bind the checked artifacts", async () => {
  const provenance = await json("evidence/provenance.json");
  for (const entry of provenance.files) {
    const hash = createHash("sha256")
      .update(await readFile(join(ROOT, entry.path)))
      .digest("hex");
    assert.equal(hash, entry.sha256, entry.path);
  }
  for (const component of ["parse", "summarize", "render", "cli"]) {
    const builder = await json(`evidence/results/build-${component}.json`);
    const reviewer = await json(`evidence/results/review-${component}.json`);
    assert.equal(reviewer.result.review.verdict, "approve");
    assert.equal(reviewer.result.review.fingerprint, builder.fingerprint);
    assert(builder.data.checks.every((check: any) => check.passed));
  }
  const destination = await json("evidence/destination.json");
  assert.equal(destination.status, "verified");
  assert.equal(destination.application, "exact");
  assert.equal(destination.review, "builder-artifacts-only");
  const events = (await readFile(join(ROOT, "evidence/parser-check-events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((e) => e.seq),
    provenance.eventExcerpt.sequences,
  );
  assert.equal(events.find((e) => e.seq === 627).ok, false);
  assert.equal(events.find((e) => e.seq === 773).ok, true);
  assert.equal(events.find((e) => e.t === "check_end").passed, true);
});

test("Relay job builds, reviews and verifies the destination through the engine with scripted responses", async (t) => {
  const starter = await files(join(ROOT, "starter"));
  const finished = await files(join(ROOT, "finished"));
  for (const name of ["verify.mjs", "expected-report.md"])
    starter[name] = await readFile(join(ROOT, name), "utf8");
  const job = await json("job.json");
  const resolved = resolveTasks(
    job.tasks,
    discoverAgents(undefined, join(ROOT, "absent-agent-dir")),
  );
  const tasks = resolved.tasks.map((task) => ({
    ...task,
    checks: task.checks?.map((c) => ({ ...c, argv: [process.execPath, ...c.argv.slice(1)] })),
  }));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const world = await fauxWorld(
    t,
    (turn) => {
      const task = byId.get(turn.agent!)!;
      if (turn.role === "builder" && turn.round === 0)
        return fauxAssistantMessage(
          task.ownership!.map((path) => fauxToolCall("write", { path, content: finished[path] })),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(
        [
          fauxToolCall("submit_result", {
            status: "succeeded",
            summary: "Scripted fixture response; no live model evaluation.",
            changedFiles: turn.role === "builder" ? (task.ownership ?? []) : [],
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
  await writeRunRecord(handle.dir, {
    schemaVersion: 2,
    definitions: resolved.definitions,
    id: handle.id,
    root: world.repo,
    head,
    tasks: validateGraph(tasks, { allowWrites: true, definitions: resolved.definitions }).map(
      taskSpec,
    ),
    allowWrites: true,
    integratedChecks: job.integratedChecks.map((c: any) => ({
      ...c,
      argv: [process.execPath, ...c.argv.slice(1)],
    })),
    noIntegratedChecksReason: null,
    passEnv: [],
    taskMs: 60_000,
  });
  const view = await handle.done;
  assert.equal(view.status, "succeeded", JSON.stringify(view.agents));
  assert.equal(Object.keys(view.agents).length, 10);
  const integrated = await integrate(handle.dir);
  assert.equal(integrated.status, "verified", JSON.stringify(integrated));
  assert.equal(node(world.repo, "verify.mjs").status, 0);
});
