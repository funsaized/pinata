// Shared by the replay reader and browser. Failed attempts remain in each cohort.
export function aggregate(trials) {
  const groups = new Map();
  for (const trial of trials) {
    const key = `${trial.contestant}/${trial.comparable ? "comparison" : "excluded"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trial);
  }
  return [...groups.values()].map((rows) => {
    const successes = rows.filter((r) => r.status === "completed" && r.quality?.success).length;
    const knownCostUsd =
      Math.round(rows.reduce((n, r) => n + r.ledger.partial.costUsd, 0) * 1e9) / 1e9;
    const costKnown = rows.every((r) => r.ledger.totals.costUsd !== null);
    return {
      contestant: rows[0].contestant,
      attempts: rows.length,
      successes,
      successRate: successes / rows.length,
      costUsd: costKnown ? knownCostUsd : null,
      knownCostUsd,
      costPerSuccessUsd: costKnown && successes > 0 ? knownCostUsd / successes : null,
      totalElapsedMs: rows.reduce((n, r) => n + r.elapsedMs, 0),
      comparable: rows[0].comparable,
      simulated: rows.every((r) => r.mode !== "live"),
    };
  });
}
