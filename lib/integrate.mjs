import path from "node:path";
import {
  need,
  equal,
  digest,
  exists,
  readJson,
  atomic,
  privateDir,
  environment,
  git,
  line,
  snapshot,
  fileState,
  applyFile,
} from "./core.mjs";
import { runChecks } from "./worker.mjs";
import { at, orderedTasks, mutate } from "./run.mjs";
import { outcome } from "./evidence.mjs";
import { closeCompletedPanes, retireWorktrees } from "./cleanup.mjs";

export async function integrate(dir) {
  return mutate(dir, async (run) => {
    need(
      !run.cancelled && Date.now() < run.deadline && run.allowWrites,
      "Integration not authorized or run expired",
    );
    need(
      run.tasks.length > 0 && run.tasks.every((t) => t.status === "succeeded"),
      "Every required task must succeed before integration",
    );
    for (const task of run.tasks)
      need(
        (await outcome(run, task)).status === "succeeded",
        "A required result is no longer valid",
      );
    need(
      line(await git(run.cwd, ["rev-parse", "HEAD"])) === run.baseCommit,
      "Target HEAD moved; replan instead of merging blindly",
    );
    const builders = run.tasks.filter((t) => t.spec.role === "builder");
    need(builders.length > 0, "No builder changes to integrate");
    const changes = new Map();
    const fingerprints = [];
    const ordered = orderedTasks(run).filter((t) => t.spec.role === "builder");
    for (const task of ordered) {
      const o = await outcome(run, task);
      fingerprints.push([task.spec.id, o.fingerprint]);
      const reviews = run.tasks.filter(
        (t) => t.spec.role === "reviewer" && t.spec.reviewOf === task.spec.id,
      );
      need(reviews.length > 0, `Independent review required for ${task.spec.id}`);
      for (const review of reviews) {
        const r = await outcome(run, review);
        need(
          r.status === "succeeded" && r.result.review.fingerprint === o.fingerprint,
          "Review is rejected or stale",
        );
      }
      for (const change of o.changes) {
        const prev = changes.get(change.path);
        if (prev) need(equal(prev.after, change.before), "Conflicting integration changes");
        changes.set(change.path, {
          ...change,
          before: prev ? prev.before : change.before,
          blobs: path.join(at(run, task), "files"),
        });
      }
    }
    const evidenceDigest = digest(fingerprints);
    const folder = path.join(run.dir, "integration");
    await privateDir(folder);
    const journalPath = path.join(folder, "journal.json");
    let journal = (await exists(journalPath)) ? await readJson(journalPath) : null;
    if (!journal || journal.evidenceDigest !== evidenceDigest || journal.status === "rolled_back") {
      const entries = [];
      for (const change of changes.values()) {
        const prior = journal?.entries.find((c) => c.path === change.path);
        const before = prior && journal.status !== "rolled_back" ? prior.after : change.before;
        need(
          equal(await fileState(run.cwd, change.path, path.join(folder, "before")), before),
          `Integration conflicts with existing changes: ${JSON.stringify(change.path)}`,
        );
        entries.push({ ...change, before });
      }
      journal = { schemaVersion: 1, evidenceDigest, entries, status: "applying" };
      await atomic(journalPath, journal);
    }
    for (const entry of journal.entries) {
      const state = await fileState(run.cwd, entry.path);
      need(
        equal(state, entry.before) || equal(state, entry.after),
        `Interrupted integration conflicts with user changes: ${JSON.stringify(entry.path)}`,
      );
    }
    for (const entry of journal.entries)
      if (!equal(await fileState(run.cwd, entry.path), entry.after))
        await applyFile(run.cwd, entry, entry.blobs);
    journal.status = "verifying";
    await atomic(journalPath, journal);
    const integratedSnapshot = await snapshot(run.cwd);
    const checks = await runChecks(run.integratedChecks, {
      cwd: run.cwd,
      env: environment(run.config),
      dir: folder,
      deadline: Math.min(run.deadline, Date.now() + run.config.limits.taskMs),
    });
    need(
      equal(integratedSnapshot, await snapshot(run.cwd)),
      "Integrated checks modified source files; inspect and re-review",
    );
    journal.status =
      checks.length === run.integratedChecks.length && checks.every((c) => c.passed)
        ? "verified"
        : "verification_failed";
    journal.checks = checks;
    journal.snapshot = integratedSnapshot;
    journal.noChecksReason = run.noIntegratedChecksReason;
    await atomic(journalPath, journal);
    run.integration = {
      status: journal.status,
      journal: journalPath,
      evidenceDigest,
      checkedAt: Date.now(),
    };
    await closeCompletedPanes(run);
    await retireWorktrees(run);
  });
}
export async function rollback(dir) {
  return mutate(dir, async (run) => {
    const folder = path.join(run.dir, "integration"),
      file = path.join(folder, "journal.json");
    const journal = await readJson(file);
    need(journal.status !== "rolled_back", "Already rolled back");
    for (const c of journal.entries)
      need(
        equal(await fileState(run.cwd, c.path), c.after),
        "Rollback conflicts with later changes; nothing overwritten",
      );
    for (const c of [...journal.entries].reverse())
      await applyFile(run.cwd, { path: c.path, after: c.before }, path.join(folder, "before"));
    journal.status = "rolled_back";
    await atomic(file, journal);
    run.integration = { status: "rolled_back", journal: file };
  });
}
