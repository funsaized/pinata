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
import { config, layeredConfig, preferredModel, modelOrigin } from "./config.mjs";
import { doctor } from "./preflight.mjs";
import { resolveSetup, snapshotBase } from "./workspace.mjs";
import { resolveSubject, validSubject } from "./subject.mjs";

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
    if (task.spec.reviewOf) {
      const target = getTask(run, task.spec.reviewOf);
      need(
        target.spec.role !== "reviewer" && task.spec.after.includes(target.spec.id),
        "Reviewer must directly depend on its review target",
      );
    } else if (task.spec.role === "reviewer")
      need(
        ![...ancestors(run, task)].some((name) => getTask(run, name).spec.role === "builder"),
        `Task ${task.spec.id}: to review a builder's change, use reviewOf instead of reviewBase or reviewPr`,
      );
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
  for (const task of run.tasks)
    if (task.spec.reviewBase !== undefined || task.spec.reviewPr !== undefined)
      need(validSubject(task.subject), `Unresolved review subject for ${task.spec.id}`);
  const common = await fs.realpath(
    line(await git(run.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  );
  need(run.dir === path.join(common, "pinata", run.id), "Run no longer belongs to this repository");
  for (const task of run.tasks)
    if (task.worktree) {
      const owner = task.spec.reviewOf ? getTask(run, task.spec.reviewOf) : task;
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
export async function init(job, { inheritedModel } = {}) {
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
  const headCommit = line(await git(root, ["rev-parse", "--verify", "HEAD"]));
  const layered = await layeredConfig(job.config ?? {}, root);
  const preflight = await doctor(layered.config);
  strings(job.instructions ?? [], "instructions");
  const sessionModel =
    inheritedModel ??
    (process.env.PI_PROVIDER && process.env.PI_MODEL
      ? {
          provider: process.env.PI_PROVIDER,
          id: process.env.PI_MODEL,
          thinking: process.env.PI_REASONING_LEVEL ?? "medium",
        }
      : null);
  if (!preflight.config.models.default && sessionModel) {
    preflight.config.models.default = validateModel(sessionModel);
    layered.origins["models.default"] = "session";
  }
  validateChecks(job.integratedChecks ?? []);
  if (job.allowWrites && !job.integratedChecks?.length)
    text(job.noIntegratedChecksReason, "noIntegratedChecksReason");
  const common = await fs.realpath(
    line(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  );
  const tasks = (job.tasks ?? []).map((t) => ({
    spec: validateTask(t),
    status: "queued",
    attempts: [],
    repairs: 0,
  }));
  const runId = randomUUID();
  const dir = path.join(common, "pinata", runId);
  const initial = await snapshot(root);
  const run = {
    schemaVersion: 1,
    id: runId,
    dir,
    cwd: root,
    baseCommit: headCommit,
    headCommit,
    uncommitted: null,
    createdAt: Date.now(),
    deadline: Date.now() + preflight.config.limits.jobMs,
    approval: job.approval,
    allowWrites: job.allowWrites ?? false,
    instructions: job.instructions ?? [],
    config: preflight.config,
    runtime: preflight.runtime,
    configSources: { files: layered.files, origins: layered.origins },
    target: preflight.target,
    versions: preflight.versions,
    initial,
    setup: null,
    integratedChecks: job.integratedChecks ?? [],
    noIntegratedChecksReason: job.noIntegratedChecksReason ?? null,
    cancelled: false,
    notes: [],
    tasks,
  };
  validateGraph(run);
  // Nothing is written until the job validates; refs from a failed init are removed.
  try {
    if (preflight.config.includeUncommitted !== false && Object.keys(initial.files).length) {
      run.uncommitted = await snapshotBase(root, headCommit, runId);
      run.baseCommit = run.uncommitted?.commit ?? headCommit;
    }
    run.setup = tasks.some((task) => task.spec.role === "builder")
      ? await resolveSetup(preflight.config.setup, root, run.baseCommit)
      : {
          command: null,
          source: "not-needed",
          reason: "Only builder tasks run dependency setup; this run has no builders.",
        };
    for (const task of tasks) task.subject = (await resolveSubject(run, task.spec)) ?? undefined;
    await privateDir(dir);
    await save(run);
  } catch (error) {
    await dropRefs(root, runId).catch(() => {});
    throw error;
  }
  return {
    run: dir,
    id: runId,
    versions: run.versions,
    runtime: run.runtime,
    setup: run.setup,
    base: baseSummary(run),
    research: preflight.research,
    config: { files: layered.files, origins: layered.origins },
    models: summary(run).tasks.map(({ id, role, model, modelOrigin }) => ({
      id,
      role,
      model,
      modelOrigin,
    })),
  };
}
// Private refs keep a run's uncommitted snapshot and fetched pull requests.
export async function dropRefs(root, runId) {
  const refs = (await git(root, ["for-each-ref", "--format=%(refname)", `refs/pinata/${runId}/`]))
    .split("\n")
    .filter(Boolean);
  for (const ref of refs) await git(root, ["update-ref", "-d", ref]);
}
// What workers start from: HEAD, plus the uncommitted changes captured at init.
export function baseSummary(run) {
  return {
    head: run.headCommit ?? run.baseCommit,
    commit: run.baseCommit,
    uncommittedFiles: run.uncommitted?.files ?? [],
  };
}

// Usage recorded for collected attempts. Live usage of running attempts is read
// from their usage.json files by spend().
function recorded(attempt) {
  return attempt.usage === undefined ? null : attempt.usage;
}
function totals(usages, limitUsd) {
  let costUsd = 0,
    tokens = 0,
    reported = false;
  for (const usage of usages)
    if (usage) {
      reported = true;
      costUsd += usage.cost ?? 0;
      tokens += usage.totalTokens ?? 0;
    }
  return {
    costUsd: reported ? Math.round(costUsd * 1e6) / 1e6 : null,
    tokens: reported ? tokens : null,
    limitUsd: limitUsd ?? null,
  };
}
export function recordedSpend(run) {
  return totals(
    run.tasks.flatMap((t) => t.attempts.map(recorded)),
    run.config.limits.costUsd,
  );
}
export async function liveUsage(run, task, attempt) {
  if (attempt.usage !== undefined) return attempt.usage;
  // Not collected yet, or a run from before usage was recorded per attempt.
  const dir = at(run, task, attempt);
  for (const [file, pick] of [
    ["outcome.json", (o) => o.metrics?.usage],
    ["usage.json", (u) => u],
  ])
    if (await exists(path.join(dir, file))) {
      const usage = await readJson(path.join(dir, file))
        .then(pick)
        .catch(() => null);
      if (usage) return usage;
    }
  return null;
}
// Recorded plus live usage, for status, the cost limit, and the Pi widget.
export async function spend(run) {
  const usages = [];
  for (const task of run.tasks)
    for (const attempt of task.attempts) usages.push(await liveUsage(run, task, attempt));
  return totals(usages, run.config.limits.costUsd);
}

export function summary(run) {
  return {
    run: run.dir,
    runtime: run.runtime,
    setup: run.setup,
    base: baseSummary(run),
    spend: recordedSpend(run),
    ...(run.costLimit && { costLimit: run.costLimit }),
    cancelled: run.cancelled,
    background: run.background
      ? {
          status: run.background.status,
          completion: run.background.coordinator
            ? (run.background.coordinator.completion ?? "herdr-agent-message")
            : "herdr-notification",
          delivery: run.background.delivery,
          notificationError: run.background.notificationError,
          notification: run.background.notification,
          error: run.background.error,
        }
      : null,
    deadline: run.deadline,
    config: {
      ...run.configSources,
      models: run.config.models,
      fallbacks: run.config.fallbacks,
      limits: run.config.limits,
      codemode: run.config.codemode !== false,
    },
    tasks: run.tasks.map((t) => ({
      id: t.spec.id,
      role: t.spec.role,
      status: t.status,
      attempt: current(t)?.number ?? 0,
      error: current(t)?.error ?? t.error,
      submissionError: current(t)?.fingerprint ? undefined : current(t)?.submissionError,
      paneClosed: current(t)?.closed,
      paneCloseError: current(t)?.paneCloseError,
      ...(t.subject && { reviewSubject: t.subject }),
      ...(t.included?.length && { included: t.included }),
      worktreeRemoved: t.worktreeRemoved,
      cleanupError: t.cleanupError,
      result: t.attempts.length ? path.join(at(run, t), "outcome.json") : null,
      model: current(t)?.model ?? preferredModel(run.config, t.spec.role, t.spec.model),
      actualModel: t.actualModel ?? null,
      modelOrigin: current(t)?.modelOrigin ?? modelOrigin(run, t.spec),
      modelState:
        t.status === "queued"
          ? "configured"
          : current(t)?.fingerprint
            ? "verified"
            : current(t)?.model
              ? "selected"
              : "configured",
      modelFallbacksUsed: current(t)?.modelFallbacksUsed ?? [],
      readinessCached: current(t)?.readinessCached,
      elapsedMs:
        t.metrics?.elapsedMs ??
        (current(t)
          ? (current(t).finishedAt ?? Date.now()) -
            (current(t).readinessStartedAt ?? current(t).startedAt)
          : null),
      metrics: t.metrics ?? null,
      failureStage: t.failureStage ?? null,
      resultSummary: t.resultSummary,
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
