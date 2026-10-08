import * as fs from "node:fs/promises";
import path from "node:path";
import {
  TERMINAL,
  need,
  text,
  equal,
  snapshot,
  exists,
  readJson,
  atomic,
  sleep,
  validateTask,
  living,
  terminate,
} from "./core.mjs";
import {
  at,
  current,
  getTask,
  ancestors,
  validateGraph,
  loadRun,
  save,
  mutate,
  spend,
} from "./run.mjs";
import { resolveSubject } from "./subject.mjs";
import { outcome, verification } from "./evidence.mjs";
import { availableShell, reconcileCreation, submit } from "./herdr.mjs";
import { prepare, launch } from "./launch.mjs";
import { resolveSetup } from "./workspace.mjs";
import { closeCompletedPanes, retireWorktrees } from "./cleanup.mjs";
import { observe, signalRun } from "./observe.mjs";

async function collect(run) {
  for (const task of run.tasks.filter((t) =>
    ["launching", "running", "preparing", "uncertain"].includes(t.status),
  )) {
    const dir = at(run, task),
      attempt = current(task);
    if (await exists(path.join(dir, "claim.json"))) {
      attempt.accepted = true;
      delete attempt.submissionError;
      task.status = "running";
      if (await exists(path.join(dir, "process.json"))) {
        const p = await readJson(path.join(dir, "process.json"));
        if (p.runner && !(await living([p.runner])).length) {
          task.status = "uncertain";
          attempt.error =
            "Supervisor disappeared without a valid outcome; inspect/cancel before repair";
        }
      }
    } else if (
      Date.now() - (attempt.lastSubmissionAt ?? attempt.startedAt) >=
      run.config.limits.startupMs
    ) {
      task.status = "uncertain";
      attempt.error = "No worker launch claim; reconcile before retrying";
    }
    // Read the outcome after liveness: a supervisor can publish and exit between
    // an earlier artifact check and ps, which is completion rather than disappearance.
    if (await exists(path.join(dir, "outcome.json"))) {
      try {
        const o = await outcome(run, task);
        task.status = o.status;
        attempt.error = o.error;
        attempt.fingerprint = o.fingerprint;
        task.metrics = o.metrics;
        task.failureStage = o.failureStage;
        task.resultSummary = o.result?.summary;
        task.verification = verification(task, o);
        task.actualModel = o.actualModel;
        attempt.finishedAt = o.finishedAt;
        attempt.usage = o.metrics?.usage ?? null;
      } catch (e) {
        task.status = "failed";
        attempt.error = e.message;
        task.failureStage = "verification";
      }
    }
    if (
      ["running", "launching"].includes(task.status) &&
      Date.now() >= Math.min(run.deadline, attempt.startedAt + run.config.limits.taskMs)
    )
      await cancelTask(run, task);
  }
}
async function cancelTask(run, task) {
  if (!task.attempts.length) {
    task.status = "cancelled";
    return;
  }
  const dir = at(run, task);
  await atomic(path.join(dir, "cancel.json"), { requestedAt: Date.now() });
  let verified = false;
  for (let i = 0; i < 25; i++) {
    if (await exists(path.join(dir, "process.json"))) {
      const p = await readJson(path.join(dir, "process.json"));
      const identities = [...(p.children ?? []), ...(p.runner ? [p.runner] : [])];
      if (!(await living(identities)).length) {
        verified = true;
        break;
      }
    } else if (!(await exists(path.join(dir, "claim.json")))) {
      try {
        verified = Boolean(await availableShell(run, current(task)));
      } catch {
        /* Ownership may be uncertain. */
      }
      if (verified) break;
    }
    await sleep(200);
  }
  if (!verified && (await exists(path.join(dir, "process.json")))) {
    const p = await readJson(path.join(dir, "process.json"));
    verified = await terminate([...(p.children ?? []), ...(p.runner ? [p.runner] : [])]);
  }
  if (verified) await fs.rm(path.join(dir, "environment.json"), { force: true });
  task.status = verified ? "cancelled" : "uncertain";
  current(task).error = verified
    ? "Cancellation termination verified; outputs retained"
    : "Cannot verify cancellation; resources retained";
}
// Stops the run once recorded and live spend reach limits.costUsd. Workers also
// stop themselves at the budget left when they launched.
async function enforceCost(run) {
  const limitUsd = run.config.limits.costUsd;
  if (!limitUsd || run.cancelled) return;
  const { costUsd } = await spend(run);
  if (costUsd === null || costUsd < limitUsd) return;
  run.cancelled = true;
  run.costLimit = { limitUsd, spentUsd: costUsd, at: Date.now() };
}
export async function tick(dir) {
  return mutate(dir, async (run) => {
    await collect(run);
    await enforceCost(run);
    if (run.cancelled || Date.now() >= run.deadline) {
      for (const t of run.tasks.filter((t) => !TERMINAL.includes(t.status)))
        await cancelTask(run, t);
      await closeCompletedPanes(run);
      await retireWorktrees(run);
      return;
    }
    let capacity =
      run.config.limits.concurrency -
      run.tasks.filter((t) => ["running", "launching", "preparing", "uncertain"].includes(t.status))
        .length;
    const preparing = [];
    let launches = Promise.resolve();
    // Filesystem/model work overlaps; Herdr mutations stay ordered. Start each
    // prepared task as soon as its own tree is ready, without a batch barrier.
    const launchReady = (run, task) => {
      const pending = launches.catch(() => {}).then(() => launch(run, task));
      launches = pending;
      return pending;
    };
    for (const task of run.tasks.filter((t) => t.status === "queued")) {
      const deps = task.spec.after.map((name) => getTask(run, name));
      if (deps.some((t) => TERMINAL.includes(t.status) && t.status !== "succeeded")) {
        task.status = "blocked";
        continue;
      }
      if (capacity <= 0 || deps.some((t) => t.status !== "succeeded")) continue;
      // A reviewer may read a target tree, but no task writes that tree during review.
      const previousAttempts = task.attempts.length;
      capacity--;
      preparing.push(
        prepare(run, task, launchReady).catch((e) => {
          task.status = "blocked";
          task.error = e.message;
          task.failureStage = task.attempts.length > previousAttempts ? "launch" : "readiness";
          if (current(task)) {
            current(task).error = e.message;
            current(task).finishedAt ??= Date.now();
          }
        }),
      );
    }
    await Promise.all(preparing);
    await closeCompletedPanes(run);
    await retireWorktrees(run);
  });
}
export async function wait(dir, waitMs = 1000) {
  need(Number.isInteger(waitMs) && waitMs > 0 && waitMs <= 300_000, "waitMs must be 1..300000");
  const until = Date.now() + waitMs;
  let status;
  const changes = await observe(dir);
  try {
    do {
      const seen = changes.revision;
      status = await tick(dir);
      if (status.tasks.every((t) => TERMINAL.includes(t.status))) return status;
      await changes.wait(seen, Math.min(5000, until - Date.now()));
    } while (Date.now() < until);
    return { ...status, waiting: true };
  } finally {
    changes.close();
  }
}
export async function add(dir, spec) {
  return mutate(dir, async (run) => {
    need(
      !run.costLimit,
      "Run reached its cost limit; start a new run with a higher limits.costUsd",
    );
    need(!run.cancelled && Date.now() < run.deadline, "Run no longer accepts tasks");
    const added = (Array.isArray(spec) ? spec : [spec]).map((item) => ({
      spec: validateTask(item),
      status: "queued",
      attempts: [],
      repairs: 0,
    }));
    run.tasks.push(...added);
    validateGraph(run);
    for (const task of added) task.subject = (await resolveSubject(run, task.spec)) ?? undefined;
    if (run.setup?.source === "not-needed" && run.tasks.some((t) => t.spec.role === "builder"))
      run.setup = await resolveSetup(run.config.setup, run.cwd, run.baseCommit);
    await signalRun(run);
  });
}
export async function barrier(dir, names) {
  const run = await loadRun(dir);
  need(names.length > 0, "Explicit barrier task IDs required");
  for (const name of names) {
    const task = getTask(run, name);
    need(
      task.status === "succeeded" && (await outcome(run, task)).status === "succeeded",
      `Barrier blocked by ${name} (${task.status})`,
    );
  }
  return { ready: true, tasks: names };
}
export async function repair(dir, name, feedback) {
  return mutate(dir, async (run) => {
    need(
      !run.costLimit,
      "Run reached its cost limit; start a new run with a higher limits.costUsd",
    );
    need(!run.cancelled && Date.now() < run.deadline, "Run stopped");
    const task = getTask(run, name);
    need(
      ["failed", "blocked", "succeeded", "rejected"].includes(task.status),
      "Inspect/cancel uncertain or active work before repairing",
    );
    text(feedback, "repair feedback");
    const dependents = run.tasks.filter((t) => ancestors(run, t).has(name));
    need(
      dependents.every((t) =>
        ["queued", "blocked", "rejected", "succeeded", "failed"].includes(t.status),
      ),
      "Dependent work is active; cancel it first",
    );
    need(
      dependents.every((t) => t.spec.role === "reviewer" || t.attempts.length === 0),
      "Completed downstream work requires a new plan/run; do not silently replay it",
    );
    for (const t of [task, ...dependents]) {
      if (t.attempts.length && (await exists(path.join(at(run, t), "process.json")))) {
        const p = await readJson(path.join(at(run, t), "process.json"));
        need(
          !(await living([...(p.children ?? []), ...(p.runner ? [p.runner] : [])])).length,
          "Previous processes are still alive",
        );
      }
    }
    const lastOutcome =
      task.attempts.length && (await exists(path.join(at(run, task), "outcome.json")))
        ? await readJson(path.join(at(run, task), "outcome.json"))
        : null;
    // Setup failures are environment problems, not worker defects: they get a small
    // separate retry budget and never consume the task's repair budget.
    const setupRetry = lastOutcome?.failureStage === "setup";
    if (setupRetry) {
      need(
        (task.setupRetries ?? 0) < 2,
        "Setup retry budget exhausted; start a new run with a corrected config.setup",
      );
      need(
        equal(await snapshot(task.worktree), task.inputSnapshot),
        "Setup modified project files; start a new run with a corrected config.setup",
      );
      task.setupRetries = (task.setupRetries ?? 0) + 1;
    } else need(task.repairs < run.config.limits.repairs, "Repair budget exhausted");
    task.resultRepair = lastOutcome?.failureStage === "result";
    if (task.resultRepair) {
      need((task.resultRepairs ?? 0) < 1, "Result-format repair budget exhausted");
      task.resultRepairs = (task.resultRepairs ?? 0) + 1;
    }
    if (!setupRetry) task.repairs++;
    task.feedback = task.resultRepair
      ? `Result-only repair: do not repeat edits or other work; reconstruct the envelope from retained evidence. ${feedback}`
      : feedback;
    task.status = "queued";
    delete task.metrics;
    delete task.failureStage;
    delete task.resultSummary;
    delete task.verification;
    delete task.actualModel;
    for (const t of dependents) {
      t.status = "queued";
      delete t.metrics;
      delete t.failureStage;
      delete t.resultSummary;
      delete t.verification;
      delete t.actualModel;
      t.feedback = "Re-review the repaired target independently; prior approval is invalid.";
    }
    run.integration = run.integration ? { ...run.integration, status: "stale" } : null;
    await signalRun(run);
  });
}
export async function retryLaunch(dir, name) {
  return mutate(dir, async (run) => {
    const task = getTask(run, name),
      attempt = current(task);
    need(
      !run.cancelled && Date.now() < run.deadline && task.status === "uncertain",
      "Only an uncertain live run can retry a submission",
    );
    need(
      attempt.submissionRetries < 1 && !(await exists(path.join(at(run, task), "claim.json"))),
      "Submission retry disallowed: budget or existing claim",
    );
    await reconcileCreation(run, task);
    need(await availableShell(run, attempt), "Target is busy; do not submit");
    // The same attempt claim makes a delayed original submission harmless; never create another attempt here.
    attempt.submissionRetries++;
    attempt.lastSubmissionAt = Date.now();
    task.status = "launching";
    await save(run);
    try {
      await submit(run, attempt, at(run, task));
      attempt.accepted = true;
    } catch (e) {
      attempt.submissionError = e.message;
    }
  });
}
export async function cancel(dir) {
  return mutate(dir, async (run) => {
    run.cancelled = true;
    await save(run);
    for (const task of run.tasks)
      if (!["succeeded", "rejected", "failed", "cancelled"].includes(task.status))
        await cancelTask(run, task);
    await closeCompletedPanes(run);
    await retireWorktrees(run);
    await signalRun(run);
  });
}
