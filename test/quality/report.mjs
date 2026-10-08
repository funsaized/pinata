export function summarize(rows) {
  const controls = rows.filter((r) => r.seededBuilder);
  const reviews = controls.map((r) => ({
    expected: r.name.includes("-reference") ? "approve" : "changes_requested",
    actual: r.tasks.find((t) => t.role === "reviewer")?.result?.review?.verdict,
  }));
  const scouts = rows.flatMap((r) => r.tasks.filter((t) => t.role === "scout"));
  const live = rows.flatMap((r) => r.tasks.filter((t) => t.live));
  const numeric = live
    .map((t) => t.metrics?.elapsedMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    completedCases: rows.length,
    infrastructureErrors: rows.filter((r) => r.error).length,
    builderOracle: rows
      .filter((r) => !r.seededBuilder)
      .map((r) => ({ case: r.name, passed: r.oracle?.passed, total: r.oracle?.total })),
    reviewControls: {
      total: reviews.length,
      evaluated: reviews.filter((r) => r.actual).length,
      falseApprovals: reviews.filter(
        (r) => r.expected === "changes_requested" && r.actual === "approve",
      ).length,
      falseRejections: reviews.filter(
        (r) => r.expected === "approve" && r.actual === "changes_requested",
      ).length,
      missingVerdicts: reviews.filter((r) => !r.actual).length,
    },
    factualClaims: {
      total: scouts.reduce((n, t) => n + t.claims.total, 0),
      correct: scouts.reduce((n, t) => n + t.claims.correct, 0),
      incorrect: scouts.reduce((n, t) => n + t.claims.incorrect, 0),
      missing: scouts.reduce((n, t) => n + t.claims.missing, 0),
      supported: scouts.reduce((n, t) => n + t.claims.supported, 0),
      noncanonical: scouts.reduce((n, t) => n + t.claims.noncanonical, 0),
    },
    liveTasks: live.length,
    failedLiveTasks: live.filter((t) => !["succeeded", "rejected"].includes(t.status)).length,
    missingUsage: live.filter((t) => !t.metrics?.usage).length,
    latencyMs: numeric.length
      ? { min: numeric[0], median: numeric[Math.floor(numeric.length / 2)], max: numeric.at(-1) }
      : null,
    usage: live.reduce(
      (sum, t) => {
        for (const key of Object.keys(sum)) sum[key] += t.metrics?.usage?.[key] ?? 0;
        return sum;
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    ),
    limitation:
      "Small controlled fixture, not a global model benchmark. Seeded builders are deterministic; their reviewers are live. Missing verdicts and usage are reported separately. All trials are retained, including failures below the quality thresholds.",
  };
}

// Keep the bar explicit and the raw results visible. Format drift is diagnostic;
// wrong values, unsupported evidence, and incorrect control verdicts fail quality.
export function qualityGate(summary) {
  const thresholds = {
    builderPassRate: 1,
    factualAccuracy: 1,
    supportedClaims: 1,
    falseApprovals: 0,
    falseRejections: 0,
    missingVerdicts: 0,
  };
  const failures = [];
  if (summary.infrastructureErrors || summary.failedLiveTasks || !summary.liveTasks)
    failures.push("Some live work failed or produced no result");
  if (
    !summary.builderOracle.length ||
    summary.builderOracle.some((r) => !r.total || r.passed !== r.total)
  )
    failures.push("Builder oracle pass rate is below 100%");
  const reviews = summary.reviewControls;
  if (
    !reviews.total ||
    reviews.evaluated !== reviews.total ||
    reviews.falseApprovals ||
    reviews.falseRejections ||
    reviews.missingVerdicts
  )
    failures.push("Review controls have incorrect or missing verdicts");
  const facts = summary.factualClaims;
  if (!facts.total || facts.correct !== facts.total || facts.incorrect || facts.missing)
    failures.push("Factual accuracy is below 100%");
  if (!facts.total || facts.supported !== facts.total)
    failures.push("Some factual answers lack matching source evidence");
  return { passed: failures.length === 0, thresholds, failures };
}
