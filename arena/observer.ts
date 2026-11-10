import { reconcileUsage } from "../engine/core/usage.ts";
import { digestValue } from "../engine/contracts/digest.ts";
import type { UsageCoverage } from "../engine/contracts/usage.ts";
import {
  observationSchema,
  recordedObservationSchema,
  type RecordedObservation,
  type Workflow,
} from "./contracts.ts";

export class Observer {
  readonly records: RecordedObservation[] = [];
  record(value: unknown, authority: RecordedObservation["authority"] = "adapter"): void {
    this.records.push(
      recordedObservationSchema.parse({
        schemaVersion: 2,
        sequence: this.records.length + 1,
        receiptNs: process.hrtime.bigint().toString(),
        receivedAt: new Date().toISOString(),
        authority,
        value,
      }),
    );
  }
}

export function reconcileObservations(raw: readonly unknown[]): UsageCoverage {
  const starts = new Map<string, { identity: string; parent?: string }>();
  const responses = new Map<string, Map<string, string>>();
  const settled = new Map<string, boolean>();
  const observations: unknown[] = [];
  const malformed: string[] = [];
  let expectedSequence = 1;
  for (const record of raw) {
    const envelope = recordedObservationSchema.safeParse(record);
    if (!envelope.success) {
      malformed.push("Malformed or truncated observation envelope");
      continue;
    }
    if (envelope.data.sequence !== expectedSequence++)
      malformed.push("Observation sequence is missing or duplicated");
    const parsed = observationSchema.safeParse(envelope.data.value);
    if (!parsed.success) {
      malformed.push(`Malformed observation ${envelope.data.sequence}`);
      continue;
    }
    const value = parsed.data;
    switch (value.kind) {
      case "start": {
        const identity = digestValue([value.run, value.worker, value.assignment]);
        const previous = starts.get(value.attempt);
        if (previous && (previous.identity !== identity || previous.parent !== value.parentAttempt))
          malformed.push(`Conflicting start: ${value.attempt}`);
        starts.set(value.attempt, { identity, parent: value.parentAttempt });
        break;
      }
      case "response": {
        const entries = responses.get(value.attempt) ?? new Map<string, string>();
        const previous = entries.get(value.response);
        if (previous && previous !== "started" && value.state !== previous)
          malformed.push(`Conflicting response terminal state: ${value.attempt}/${value.response}`);
        entries.set(value.response, value.state);
        responses.set(value.attempt, entries);
        break;
      }
      case "usage":
        observations.push(value.observation);
        break;
      case "settled": {
        if (settled.has(value.attempt) && settled.get(value.attempt) !== value.complete)
          malformed.push(`Conflicting settlement: ${value.attempt}`);
        settled.set(value.attempt, value.complete);
        break;
      }
      case "stage":
        break;
    }
  }
  for (const [id, start] of starts)
    if (start.parent && !starts.has(start.parent))
      malformed.push(`Unknown parent attempt for ${id}`);
  for (const id of [...responses.keys(), ...settled.keys()])
    if (!starts.has(id)) malformed.push(`Observation names unstarted attempt: ${id}`);
  const responseIds = Object.fromEntries(
    [...responses].map(([id, values]) => [id, [...values.keys()]]),
  );
  const incompleteAttempts = [...starts.keys()].filter(
    (id) =>
      !settled.get(id) ||
      [...(responses.get(id)?.values() ?? [])].some((state) => state !== "completed"),
  );
  return reconcileUsage([...starts.keys()], observations, {
    responseIds,
    incompleteAttempts,
    malformed,
  });
}

export function treatmentEvidence(
  records: readonly RecordedObservation[],
  options: {
    offline: boolean;
    cleanupConfirmed: boolean;
    expectedStages: string[];
    workflow?: Workflow;
    units?: string[];
  },
): { verified: boolean; comparisonEligible: boolean; reasons: string[] } {
  const completed = new Set<string>();
  const open = new Set<string>();
  const reasons: string[] = [];
  const intervals = new Map<string, { start: bigint; end?: bigint }>();
  let previous = 0n;
  for (const record of records) {
    if (record.authority !== "supervisor") continue;
    const time = BigInt(record.receiptNs);
    if (time < previous) reasons.push("Supervisor monotonic time moved backwards");
    previous = time;
    const parsed = observationSchema.safeParse(record.value);
    if (!parsed.success) {
      reasons.push("Malformed supervisor observation");
      continue;
    }
    if (parsed.data.kind !== "stage") continue;
    const key = `${parsed.data.stage}/${parsed.data.subject}`;
    if (parsed.data.action === "start") {
      if (open.has(key) || completed.has(key)) reasons.push(`Duplicate supervised stage ${key}`);
      open.add(key);
      intervals.set(key, { start: time });
    } else if (!open.delete(key)) reasons.push(`Unstarted supervised stage ${key}`);
    else {
      completed.add(key);
      const interval = intervals.get(key);
      if (interval) interval.end = time;
    }
  }
  if (open.size) reasons.push("Supervisor stages remain unfinished");
  for (const stage of options.expectedStages)
    if (![...completed].some((key) => key.startsWith(`${stage}/`)))
      reasons.push(`Missing independent ${stage} stage evidence`);
  const builds = (options.units ?? []).map((unit) => intervals.get(`build/${unit}`));
  if (builds.some((interval) => !interval?.end))
    reasons.push("A prescribed build unit lacks complete supervisor evidence");
  const complete = builds.filter(
    (interval): interval is { start: bigint; end: bigint } => interval?.end !== undefined,
  );
  if (options.workflow?.startsWith("sequential"))
    for (let index = 1; index < complete.length; index++) {
      if (complete[index].start < complete[index - 1].end)
        reasons.push("Sequential build stages overlapped");
    }
  if (options.workflow?.startsWith("parallel") && complete.length > 1) {
    const latestStart = complete.reduce(
      (last, interval) => (interval.start > last ? interval.start : last),
      0n,
    );
    const earliestEnd = complete.reduce(
      (first, interval) => (interval.end < first ? interval.end : first),
      complete[0].end,
    );
    if (latestStart >= earliestEnd)
      reasons.push("Parallel build overlap was not independently observed");
  }
  const review = intervals.get("review/review");
  if (review && complete.some((build) => build.end > review.start))
    reasons.push("Review started before prescribed build stages ended");
  if (!options.cleanupConfirmed) reasons.push("Process cleanup is unconfirmed");
  const verified = !reasons.length;
  if (options.offline)
    reasons.push("Scripted reference-copy controls establish harness behavior only");
  if (!options.offline)
    reasons.push(
      "Native workflow attestation is incomplete; adapter claims are not independent evidence",
    );
  return { verified, comparisonEligible: false, reasons };
}
