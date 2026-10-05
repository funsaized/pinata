import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { need, digest, atomic, privateDir, environment, git, snapshot } from "./core.mjs";
import { selectModel, modelCache, modelOrigin } from "./config.mjs";
import { RESEARCH_UNAVAILABLE, at, getTask, save } from "./run.mjs";
import { outcome } from "./evidence.mjs";
import { createWorkspace, submit } from "./herdr.mjs";
import { ensureWorktree, LOCKFILES } from "./workspace.mjs";
import { ensureNode } from "./runtime.mjs";

async function reviewTargetFor(run, task, dir, cwd) {
  const target = getTask(run, task.spec.reviewOf);
  const evidence = await outcome(run, target);
  need(evidence.status === "succeeded", "Review target not verified");
  const reviewTarget = {
    taskId: target.spec.id,
    fingerprint: evidence.fingerprint,
    taskSpec: path.join(at(run, target), "task.json"),
    result: path.join(at(run, target), "outcome.json"),
    diff: path.join(dir, "review.diff"),
  };
  await fs.writeFile(
    reviewTarget.diff,
    await git(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--binary",
      "HEAD",
      "--",
    ]),
    { mode: 0o600 },
  );
  return reviewTarget;
}

function payloadFor(run, task, attempt, { dir, cwd, selected, baseline, reviewTarget }) {
  return {
    schemaVersion: 1,
    runId: run.id,
    sessionId: randomUUID(),
    attemptId: `${task.spec.id}-${attempt.number}`,
    attemptDir: dir,
    task: { ...task.spec, instructions: [...run.instructions, ...task.spec.instructions] },
    cwd,
    model: selected.model,
    modelFallbacksUsed: selected.skipped,
    modelOrigin: attempt.modelOrigin,
    startedAt: attempt.startedAt,
    readinessStartedAt: attempt.readinessStartedAt,
    readinessMs: attempt.readinessMs,
    pi: run.config.pi,
    webExtension: task.spec.role === "research" ? run.config.webExtension : null,
    config: { passEnv: run.config.passEnv },
    baseline,
    inputSnapshot: task.inputSnapshot,
    reviewTarget,
    feedback: task.feedback ?? null,
    resultRepair: task.resultRepair ?? false,
    dependencies: task.spec.after.map((name) => ({
      taskId: name,
      outcome: path.join(at(run, getTask(run, name)), "outcome.json"),
    })),
    setup:
      task.spec.role === "builder" && run.setup?.command
        ? {
            command: run.setup.command,
            root: run.cwd,
            marker: path.join(run.dir, "setup", `${task.spec.id}.json`),
            lockfiles: LOCKFILES,
          }
        : null,
    codemode: run.config.codemode !== false,
    deadline: Math.min(run.deadline, attempt.startedAt + run.config.limits.taskMs),
    maxTurns: run.config.limits.maxTurns,
    maxToolCalls: run.config.limits.maxToolCalls,
  };
}

export async function prepare(run, task) {
  await ensureNode(run);
  for (const name of task.spec.after)
    need(
      (await outcome(run, getTask(run, name))).status === "succeeded",
      `Dependency evidence is not valid: ${name}`,
    );
  delete task.error;
  const readinessStartedAt = Date.now();
  const selected = await selectModel(
    run.config,
    task.spec.role,
    run.cwd,
    task.spec.model,
    await modelCache(run),
  );
  if (task.spec.role === "research") need(run.config.webExtension, RESEARCH_UNAVAILABLE);
  const attempt = {
    number: task.attempts.length + 1,
    startedAt: Date.now(),
    submissionRetries: 0,
    label: `pinata-${run.id}-${task.spec.id}-${task.attempts.length + 1}`,
    model: selected.model,
    modelOrigin: modelOrigin(run, task.spec, selected.skipped.length > 0),
    modelFallbacksUsed: selected.skipped,
    readinessMs: Date.now() - readinessStartedAt,
    readinessStartedAt,
    readinessCached: selected.cached,
  };
  task.attempts.push(attempt);
  task.status = "preparing";
  await save(run);
  const dir = at(run, task);
  await privateDir(dir);
  const cwd = await ensureWorktree(run, task);
  task.worktree = cwd;
  const reviewTarget =
    task.spec.role === "reviewer" ? await reviewTargetFor(run, task, dir, cwd) : null;
  const baseline = await snapshot(cwd);
  if (task.spec.role !== "builder" || !task.inputSnapshot) task.inputSnapshot = baseline;
  const payload = payloadFor(run, task, attempt, { dir, cwd, selected, baseline, reviewTarget });
  await atomic(path.join(dir, "task.json"), { ...payload, taskDigest: digest(payload) });
  // Herdr's long-lived server does not inherit the coordinating Pi's environment.
  // A private, single-use capsule avoids putting approved credential values in pane commands/argv.
  await atomic(path.join(dir, "environment.json"), environment(run.config));
  task.status = "launching";
  await save(run);
  try {
    await createWorkspace(run, attempt, cwd, () => save(run));
    await submit(run, attempt, dir);
    attempt.accepted = true;
  } catch (e) {
    attempt.submissionError = e.message;
  }
  await save(run);
}
