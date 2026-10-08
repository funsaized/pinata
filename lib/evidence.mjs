import * as fs from "node:fs/promises";
import path from "node:path";
import {
  TERMINAL,
  need,
  equal,
  digest,
  fileHash,
  owns,
  exists,
  readJson,
  snapshot,
  delta,
  validateResult,
  plannedChecks,
} from "./core.mjs";
import { at, current } from "./run.mjs";

export async function outcome(run, task) {
  const attempt = current(task);
  need(attempt, `No attempt for ${task.spec.id}`);
  const spec = await readJson(path.join(at(run, task), "task.json"));
  const { taskDigest, ...payload } = spec;
  need(
    taskDigest === digest(payload) &&
      spec.runId === run.id &&
      spec.task.id === task.spec.id &&
      spec.cwd === task.worktree,
    "Task specification changed or escaped its run",
  );
  const o = await readJson(path.join(at(run, task), "outcome.json"));
  const archived = !(await exists(spec.cwd));
  if (archived)
    need(
      attempt.archivedOutcome === digest(o),
      "Evidence is stale: archived outcome changed or worktree is missing",
    );
  need(
    o.schemaVersion === 1 && o.taskDigest === spec.taskDigest && TERMINAL.includes(o.status),
    "Invalid task outcome",
  );
  if (o.status === "succeeded" || o.status === "rejected") {
    const checks = plannedChecks(spec.task);
    validateResult(o.result, spec);
    need(
      o.result.status === "succeeded" &&
        o.process?.code === 0 &&
        !o.process.reason &&
        o.process.terminated &&
        o.settled &&
        o.finalStopReason === "stop",
      "Invalid successful process evidence",
    );
    need(
      Array.isArray(o.checks) &&
        o.checks.length === checks.length &&
        o.checks.every(
          (c, i) =>
            c.id === checks[i].id &&
            equal(c.argv, checks[i].argv) &&
            c.passed &&
            c.code === 0 &&
            !c.reason &&
            c.terminated &&
            c.cwd === spec.cwd,
        ),
      "Required verification evidence missing",
    );
    need(
      Array.isArray(o.changes) && o.changes.every((c) => owns(task.spec.ownership, c.path)),
      "Outcome ownership mismatch",
    );
    need(
      o.fingerprint === digest({ snapshot: o.snapshot, result: o.result, checks: o.checks }) &&
        (archived || equal(o.snapshot, await snapshot(spec.cwd))),
      "Evidence is stale: working tree changed",
    );
    need(
      archived || equal(o.changes, await delta(spec.cwd, spec.inputSnapshot, o.snapshot)),
      "Change artifact does not match the working tree",
    );
    for (const c of o.checks) {
      const log = path.join(at(run, task), `check-${c.id}.stdout.log`);
      need((await exists(log)) && (await fs.lstat(log)).isFile(), "Missing check log");
      const targeted = spec.task.evidenceChecks?.some((check) => check.id === c.id);
      // Legacy builder checks predate content digests. Targeted factual evidence
      // always binds the bytes the coordinator reads, not just the log's name.
      if (targeted || c.stdoutSha256 !== undefined || c.stderrSha256 !== undefined) {
        need(
          c.log === `check-${c.id}.stdout.log` && c.errorLog === `check-${c.id}.stderr.log`,
          "Invalid check log path",
        );
        const hashes = await Promise.all([
          fileHash(log),
          fileHash(path.join(at(run, task), c.errorLog)),
        ]);
        need(hashes[0] === c.stdoutSha256 && hashes[1] === c.stderrSha256, "Check output changed");
      }
    }
    if (task.spec.role === "reviewer")
      need(
        (o.status === "succeeded") === (o.result.review.verdict === "approve"),
        "Review verdict/status mismatch",
      );
  }
  return o;
}

// Task completion validates execution and workspace evidence, not every factual
// sentence. Targeted checks provide observations for the coordinator to compare
// with the report; they do not certify unrelated claims.
export function verification(task, o) {
  const complete = ["succeeded", "rejected"].includes(o.status);
  const evidence = new Set((task.spec.evidenceChecks ?? []).map((c) => c.id));
  return {
    report: complete ? "completed" : "incomplete",
    claims: "not-automatically-verified",
    acceptanceChecks: (o.checks ?? [])
      .filter((c) => !evidence.has(c.id))
      .map((c) => ({ id: c.id, passed: c.passed })),
    factualEvidence: (o.checks ?? [])
      .filter((c) => evidence.has(c.id))
      .map((c) => ({ id: c.id, passed: c.passed, log: c.log, sha256: c.stdoutSha256 })),
  };
}
