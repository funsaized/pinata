import {
  assignmentKey,
  digestValue,
  usageObservationSchema,
  usageSchema,
  type AssignmentRef,
  type CoreState,
  type Usage,
  type UsageCoverage,
  type UsageObservation,
} from "../contracts/index.ts";

export type UsageOptions = {
  incompleteAttempts?: readonly string[];
  responseIds?: Record<string, string[]>;
  malformed?: readonly string[];
};
const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost === null || right.cost === null ? null : left.cost + right.cost,
  };
}

export function reconcileUsage(
  expectedAttempts: readonly string[],
  values: readonly unknown[],
  options: UsageOptions = {},
): UsageCoverage {
  const expected = new Set(expectedAttempts);
  const issues = [...(options.malformed ?? [])];
  if (expected.size !== expectedAttempts.length)
    issues.push("Expected attempt registry contains duplicate identities");
  const observations: UsageObservation[] = [];
  const sources = new Map<string, string>();
  for (const [index, value] of values.entries()) {
    const parsed = usageObservationSchema.safeParse(value);
    if (!parsed.success) {
      issues.push(`Malformed usage record ${index}`);
      continue;
    }
    const observation = parsed.data;
    if (!expected.has(observation.attempt)) {
      issues.push(`Usage names an unstarted attempt: ${observation.attempt}`);
      observations.push(observation);
      continue;
    }
    const key = JSON.stringify([observation.attempt, observation.source]);
    const digest = digestValue(observation);
    const previous = sources.get(key);
    if (previous === digest) continue;
    if (previous)
      issues.push(
        `Conflicting usage records from ${observation.source} for ${observation.attempt}`,
      );
    sources.set(key, digest);
    observations.push(observation);
  }
  const missingAttempts: string[] = [];
  let observedTotal = zeroUsage();
  for (const attempt of expected) {
    const records = observations.filter((observation) => observation.attempt === attempt);
    const totals = new Map<string, Usage>();
    const responses = new Map<string, Usage>();
    let hasConflict = false;
    for (const record of records) {
      if (record.kind !== "response") {
        totals.set(digestValue(record.usage), record.usage);
        continue;
      }
      if (!record.responseId) {
        issues.push(`Response usage lacks an identity for ${attempt}`);
        hasConflict = true;
        continue;
      }
      const previous = responses.get(record.responseId);
      if (previous && digestValue(previous) !== digestValue(record.usage)) {
        issues.push(`Conflicting response usage for ${attempt}/${record.responseId}`);
        hasConflict = true;
      }
      responses.set(record.responseId, record.usage);
    }
    const expectedResponses =
      options.responseIds && Object.hasOwn(options.responseIds, attempt)
        ? options.responseIds[attempt]
        : undefined;
    const responsesComplete =
      expectedResponses !== undefined &&
      expectedResponses.length === responses.size &&
      expectedResponses.every((response) => responses.has(response));
    const responseTotal = [...responses.values()].reduce(addUsage, zeroUsage());
    let total: Usage | undefined;
    if (totals.size > 1) {
      issues.push(`Conflicting attempt totals for ${attempt}`);
      hasConflict = true;
    } else if (totals.size === 1) total = totals.values().next().value;
    if (responsesComplete) {
      if (total && digestValue(total) !== digestValue(responseTotal)) {
        issues.push(`Attempt and response totals disagree for ${attempt}`);
        hasConflict = true;
      } else total = responseTotal;
    }
    if (!total || hasConflict || options.incompleteAttempts?.includes(attempt))
      missingAttempts.push(attempt);
    if (!hasConflict) observedTotal = addUsage(observedTotal, total ?? responseTotal);
  }
  const summed = usageSchema.safeParse(observedTotal);
  if (!summed.success) issues.push("Aggregated usage exceeds the supported numeric range");
  const complete = missingAttempts.length === 0 && issues.length === 0;
  return {
    expectedAttempts: [...expected],
    observations,
    complete,
    total: complete && summed.success ? summed.data : null,
    observedTotal: summed.success ? summed.data : null,
    missingAttempts,
    issues,
    ...(!complete
      ? {
          reason: [
            ...issues,
            ...(missingAttempts.length
              ? [`Incomplete usage for attempts: ${missingAttempts.join(", ")}`]
              : []),
          ].join("; "),
        }
      : {}),
  };
}

export function assignmentUsage(state: CoreState, ref: AssignmentRef): UsageCoverage {
  const attempts = Object.values(state.attempts).filter(
    (entry) => assignmentKey(entry.attempt.ref) === assignmentKey(ref),
  );
  const observations: UsageObservation[] = [];
  const incompleteAttempts: string[] = [];
  const malformed: string[] = [];
  const responseIds: Record<string, string[]> = {};
  for (const entry of attempts) {
    const id = entry.attempt.id;
    observations.push(...entry.usageObservations, ...(entry.outcome?.usage.observations ?? []));
    if (!entry.outcome?.usage.complete) incompleteAttempts.push(id);
    if (
      entry.outcome &&
      (entry.outcome.usage.expectedAttempts.length !== 1 ||
        entry.outcome.usage.expectedAttempts[0] !== id)
    )
      malformed.push(`Outcome usage registry disagrees with started attempt ${id}`);
    if (Object.values(entry.responses).some((status) => status !== "completed"))
      incompleteAttempts.push(id);
    if (Object.keys(entry.responses).length)
      Object.defineProperty(responseIds, id, {
        value: Object.keys(entry.responses),
        enumerable: true,
      });
  }
  return reconcileUsage(
    attempts.map((entry) => entry.attempt.id),
    observations,
    { incompleteAttempts, responseIds, malformed },
  );
}
