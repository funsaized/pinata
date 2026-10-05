import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  need,
  text,
  strings,
  owns,
  checkedKeys,
  exists,
  readJson,
  atomic,
  privateDir,
  withLock,
  git,
  line,
  snapshot,
  validateChecks,
  validateTask,
  validateModel,
  living,
  sleep,
} from "./core.mjs";
import { config, layeredConfig } from "./config.mjs";
import { doctor } from "./preflight.mjs";
import { resolveSetup } from "./workspace.mjs";

export const RESEARCH_UNAVAILABLE =
  "Research tasks need pi-web-access, which is not installed in Pi. Install it with `pi install git:github.com/nicobailon/pi-web-access`, or set config.webExtension.";
export function at(run, task, attempt = task.attempts.at(-1)) {
  return path.join(run.dir, "tasks", task.spec.id, String(attempt.number));
}
export function current(task) {
  return task.attempts.at(-1);
}
export function getTask(run, name) {
  const task = run.tasks.find((t) => t.spec.id === name);
  need(task, `Unknown task: ${name}`);
  return task;
}
export function ancestors(run, task, seen = new Set()) {
  for (const name of task.spec.after) {
    if (!seen.has(name)) {
      seen.add(name);
      ancestors(run, getTask(run, name), seen);
    }
  }
  return seen;
}
export function orderedTasks(run) {
  const ordered = [],
    seen = new Set();
  const visit = (task) => {
    if (seen.has(task.spec.id)) return;
    seen.add(task.spec.id);
    task.spec.after.forEach((name) => visit(getTask(run, name)));
    ordered.push(task);
  };
  run.tasks.forEach(visit);
  return ordered;
}
export function validateGraph(run) {
  const ids = run.tasks.map((t) => t.spec.id);
  need(new Set(ids).size === ids.length, "Duplicate task ID");
  const visiting = new Set(),
    done = new Set();
  const visit = (task) => {
    need(!visiting.has(task.spec.id), "Cyclic task dependencies");
    if (done.has(task.spec.id)) return;
    visiting.add(task.spec.id);
    for (const dep of task.spec.after) visit(getTask(run, dep));
    visiting.delete(task.spec.id);
    done.add(task.spec.id);
  };
  run.tasks.forEach(visit);
  for (const task of run.tasks) {
    if (task.spec.role === "research") need(run.config.webExtension, RESEARCH_UNAVAILABLE);
    if (task.spec.role === "builder")
      need(run.allowWrites, "Job has no authorization for local writes");
    if (task.spec.role === "reviewer") {
      const target = getTask(run, task.spec.reviewOf);
      need(
        target.spec.role !== "reviewer" && task.spec.after.includes(target.spec.id),
        "Reviewer must directly depend on its review target",
      );
    }
    for (const other of run.tasks)
      if (task !== other && task.spec.role === "builder" && other.spec.role === "builder") {
        const overlaps = task.spec.ownership.some(
          (p) => owns(other.spec.ownership, p) || other.spec.ownership.some((q) => owns([p], q)),
        );
        need(
          !overlaps ||
            ancestors(run, task).has(other.spec.id) ||
            ancestors(run, other).has(task.spec.id),
          "Independent builders have overlapping ownership",
        );
      }
  }
}
export async function loadRun(dir) {
  const actual = await fs.realpath(dir);
  const run = await readJson(path.join(actual, "manifest.json"));
  need(
    run.schemaVersion === 1 && run.dir === actual && /^[a-f0-9-]{36}$/.test(run.id),
    "Invalid pinata manifest",
  );
  need(
    run.baseCommit && Array.isArray(run.tasks) && Number.isSafeInteger(run.deadline),
    "Incomplete manifest",
  );
  config(run.config);
  for (const task of run.tasks) {
    validateTask(task.spec);
    need(Array.isArray(task.attempts) && task.attempts.length <= 32, "Invalid attempts");
  }
  validateGraph(run);
  const common = await fs.realpath(
    line(await git(run.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  );
  need(run.dir === path.join(common, "pinata", run.id), "Run no longer belongs to this repository");
  for (const task of run.tasks)
    if (task.worktree) {
      const owner = task.spec.role === "reviewer" ? getTask(run, task.spec.reviewOf) : task;
      need(
        task.worktree === path.join(run.dir, "worktrees", owner.spec.id),
        "Unowned worktree path in manifest",
      );
      if (await exists(task.worktree))
        need(!(await fs.lstat(task.worktree)).isSymbolicLink(), "Worktree replaced by a symlink");
    }
  if (
    ["starting", "running"].includes(run.background?.status) &&
    run.background.runner &&
    !(await living([run.background.runner])).length
  ) {
    run.background.status = "stopped";
    run.background.error =
      "Background coordinator stopped; inspect background.log and restart with start";
  }
  return run;
}
export async function save(run) {
  await atomic(path.join(run.dir, "manifest.json"), run);
}
export async function init(job) {
  checkedKeys(
    job,
    [
      "cwd",
      "approval",
      "allowWrites",
      "instructions",
      "config",
      "tasks",
      "integratedChecks",
      "noIntegratedChecksReason",
    ],
    "job",
  );
  text(job.approval, "user scope approval");
  need(typeof (job.allowWrites ?? false) === "boolean", "Invalid allowWrites");
  const cwd = await fs.realpath(text(job.cwd, "cwd"));
  const root = await fs.realpath(line(await git(cwd, ["rev-parse", "--show-toplevel"])));
  need(
    cwd === root,
    "Initialize from the Git root so ownership paths and evidence are unambiguous",
  );
  const baseCommit = line(await git(root, ["rev-parse", "--verify", "HEAD"]));
  const layered = await layeredConfig(job.config ?? {}, root);
  const preflight = await doctor(layered.config);
  strings(job.instructions ?? [], "instructions");
  if (!preflight.config.models.default && process.env.PI_PROVIDER && process.env.PI_MODEL)
    preflight.config.models.default = validateModel({
      provider: process.env.PI_PROVIDER,
      id: process.env.PI_MODEL,
      thinking: process.env.PI_REASONING_LEVEL ?? "medium",
    });
  validateChecks(job.integratedChecks ?? []);
  if (job.allowWrites && !job.integratedChecks?.length)
    text(job.noIntegratedChecksReason, "noIntegratedChecksReason");
  const common = await fs.realpath(
    line(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  );
  const runId = randomUUID();
  const dir = path.join(common, "pinata", runId);
  await privateDir(dir);
  const run = {
    schemaVersion: 1,
    id: runId,
    dir,
    cwd: root,
    baseCommit,
    createdAt: Date.now(),
    deadline: Date.now() + preflight.config.limits.jobMs,
    approval: job.approval,
    allowWrites: job.allowWrites ?? false,
    instructions: job.instructions ?? [],
    config: preflight.config,
    configSources: { files: layered.files, origins: layered.origins },
    target: preflight.target,
    versions: preflight.versions,
    initial: await snapshot(root),
    setup: (job.tasks ?? []).some((task) => task.role === "builder")
      ? await resolveSetup(preflight.config.setup, root, baseCommit)
      : {
          command: null,
          source: "not-needed",
          reason: "Only builder tasks run dependency setup; this run has no builders.",
        },
    integratedChecks: job.integratedChecks ?? [],
    noIntegratedChecksReason: job.noIntegratedChecksReason ?? null,
    cancelled: false,
    notes: [],
    tasks: (job.tasks ?? []).map((t) => ({
      spec: validateTask(t),
      status: "queued",
      attempts: [],
      repairs: 0,
    })),
  };
  validateGraph(run);
  await save(run);
  return {
    run: dir,
    id: runId,
    versions: run.versions,
    setup: run.setup,
    research: preflight.research,
    config: { files: layered.files, origins: layered.origins },
  };
}
export function summary(run) {
  return {
    run: run.dir,
    setup: run.setup,
    cancelled: run.cancelled,
    background: run.background
      ? {
          status: run.background.status,
          completion: run.background.coordinator ? "herdr-agent-message" : "herdr-notification",
          delivery: run.background.delivery,
          notificationError: run.background.notificationError,
          error: run.background.error,
        }
      : null,
    deadline: run.deadline,
    tasks: run.tasks.map((t) => ({
      id: t.spec.id,
      role: t.spec.role,
      status: t.status,
      attempt: current(t)?.number ?? 0,
      error: current(t)?.error ?? t.error,
      submissionError: current(t)?.fingerprint ? undefined : current(t)?.submissionError,
      paneClosed: current(t)?.closed,
      paneCloseError: current(t)?.paneCloseError,
      worktreeRemoved: t.worktreeRemoved,
      cleanupError: t.cleanupError,
      result: t.attempts.length ? path.join(at(run, t), "outcome.json") : null,
    })),
    integration: run.integration ?? null,
  };
}
export async function mutate(dir, fn) {
  const root = await fs.realpath(dir);
  const until = Date.now() + 20_000;
  while (true) {
    try {
      return await withLock(root, async () => {
        const run = await loadRun(dir);
        const result = await fn(run);
        await save(run);
        return result ?? summary(run);
      });
    } catch (e) {
      if (!e.message.startsWith("Run is locked") || Date.now() >= until) throw e;
      const run = await loadRun(root);
      const lock = await readJson(path.join(root, "coordinator.lock")).catch(() => null);
      if (!lock) continue;
      const runner = run.background?.runner;
      if (!runner || lock.pid !== runner.pid || !(await living([runner])).length) throw e;
      await sleep(50);
    }
  }
}
