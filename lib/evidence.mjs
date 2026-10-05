import * as fs from "node:fs/promises";
import path from "node:path";
import {
  TERMINAL,
  need,
  equal,
  digest,
  owns,
  exists,
  readJson,
  snapshot,
  delta,
  validateResult,
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
  need(
    o.schemaVersion === 1 && o.taskDigest === spec.taskDigest && TERMINAL.includes(o.status),
    "Invalid task outcome",
  );
  if (o.status === "succeeded" || o.status === "rejected") {
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
        o.checks.length === spec.task.checks.length &&
        o.checks.every(
          (c, i) =>
            c.id === spec.task.checks[i].id &&
            equal(c.argv, spec.task.checks[i].argv) &&
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
        equal(o.snapshot, await snapshot(spec.cwd)),
      "Evidence is stale: working tree changed",
    );
    need(
      equal(o.changes, await delta(spec.cwd, spec.inputSnapshot, o.snapshot)),
      "Change artifact does not match the working tree",
    );
    for (const c of o.checks) {
      const log = path.join(at(run, task), `check-${c.id}.stdout.log`);
      need((await exists(log)) && (await fs.lstat(log)).isFile(), "Missing check log");
    }
    if (task.spec.role === "reviewer")
      need(
        (o.status === "succeeded") === (o.result.review.verdict === "approve"),
        "Review verdict/status mismatch",
      );
  }
  return o;
}
