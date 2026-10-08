// One accuracy score for comparing harnesses on the quality eval: the mean of the builder
// oracle pass rate, review-control accuracy and scout factual accuracy, each over every
// opportunity (a failed task scores zero for its share). Result-format failures are counted
// separately: tasks that ran but produced no valid result.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ORACLE_CASES = 29;
const CLAIMS = 7;

export function score(reports, isFormatFailure) {
  const pipelines = reports.filter((r) => !r.seededBuilder);
  const controls = reports.filter((r) => r.seededBuilder);
  const builder =
    pipelines.reduce((n, r) => n + (r.oracle?.passed ?? 0), 0) /
    (pipelines.length * ORACLE_CASES || 1);
  const review =
    controls.filter((r) => {
      const verdict = r.tasks.find((t) => t.role === "reviewer")?.result?.review?.verdict;
      return verdict === (r.name.endsWith("-reference") ? "approve" : "changes_requested");
    }).length / (controls.length || 1);
  const scouts = pipelines.flatMap((r) => r.tasks.filter((t) => t.role === "scout"));
  const factual =
    scouts.reduce((n, t) => n + (t.claims?.correct ?? 0), 0) / (scouts.length * CLAIMS || 1);
  const live = reports.flatMap((r) => r.tasks.filter((t) => t.live !== false));
  const round = (n) => Math.round(n * 10000) / 10000;
  return {
    composite: round((builder + review + factual) / 3),
    builderPassRate: round(builder),
    reviewAccuracy: round(review),
    factualAccuracy: round(factual),
    resultFormatFailures: live.filter(isFormatFailure).length,
  };
}

export function frozen(files) {
  return Object.fromEntries(
    files.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(new URL(file, import.meta.url)))
        .digest("hex"),
    ]),
  );
}

export const FROZEN_FILES = ["./fixtures.mjs", "./oracle.mjs", "./report.mjs", "./score.mjs"];
