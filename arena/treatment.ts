import type { AdapterResponse, Workflow } from "./types.ts";

export interface TreatmentVerification {
  status: "verified-control" | "unverified" | "invalid";
  reasons: string[];
}

export interface TreatmentInput {
  mode: "scripted-control" | "external";
  workflow: Workflow;
  unitIds: string[];
  maxRepairs: number;
  response: AdapterResponse | null;
}

/** Only the harness-selected control implementation is trusted to emit stage evidence. */
export function verifyTreatment(input: TreatmentInput): TreatmentVerification {
  const { mode, workflow, unitIds, maxRepairs, response } = input;
  if (mode === "external") {
    const reasons = [
      "External stage events, attempts and repairs are adapter-reported; supervisor-owned workflow evidence is not implemented.",
      "No live framework integration is verified by this harness.",
    ];
    if (!response?.events.length) reasons.push("No stage events were supplied.");
    if (response?.attempts == null || response.repairs == null)
      reasons.push(
        "Attempt or repair counts are unknown; resource-budget compliance is unverified.",
      );
    if (response?.repairs != null && response.repairs > maxRepairs)
      reasons.push("Reported repairs exceed the requested repair budget.");
    return { status: "unverified", reasons };
  }
  if (!response)
    return {
      status: "unverified",
      reasons: ["No completed scripted control evidence is available."],
    };

  const reasons: string[] = [];
  const issue = (reason: string) => reasons.push(reason);
  if (response.status !== "completed") issue("Scripted control execution did not complete.");
  if (response.framework.name !== "scripted-control" || response.model !== null)
    issue("The control response does not identify the harness's scripted implementation.");
  if (!unitIds.length || new Set(unitIds).size !== unitIds.length)
    issue("Expected control unit IDs must be nonempty and unique.");
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0)
    issue("The requested repair budget is invalid.");

  const events = response.events;
  const review = workflow.endsWith("-review");
  const parallel = workflow.startsWith("parallel");
  const statuses: Record<string, string[]> = {
    control: ["started", "completed"],
    builder: ["started", "completed"],
    review: ["started", "passed", "differences-found"],
    repair: ["started", "completed"],
    handoff: ["completed"],
    integration: ["started", "completed"],
  };
  for (const event of events) {
    if (!Object.hasOwn(statuses, event.stage) || !statuses[event.stage]!.includes(event.status)) {
      issue(`Unsupported control stage/status: ${event.stage}/${event.status}.`);
      continue;
    }
    if (event.stage === "control" || event.stage === "integration") {
      if (event.unit !== undefined) issue(`Global ${event.stage} event must not name a unit.`);
    } else if (!event.unit || !unitIds.includes(event.unit)) {
      issue(`Unknown or missing unit for ${event.stage}: ${event.unit ?? "unknown"}.`);
    }
    if (!review && (event.stage === "review" || event.stage === "repair"))
      issue(`Unexpected ${event.stage} event in a workflow without review.`);
  }
  const indices = (stage: string, status: string, unit?: string) =>
    events.flatMap((event, index) =>
      event.stage === stage && event.status === status && event.unit === unit ? [index] : [],
    );
  const exactlyOne = (stage: string, status: string, unit?: string) => {
    const found = indices(stage, status, unit);
    if (found.length !== 1)
      issue(`Expected one ${stage}/${status}${unit ? ` for ${unit}` : ""}; found ${found.length}.`);
    return found.length === 1 ? found[0]! : -1;
  };
  const ordered = (label: string, positions: number[]) => {
    if (positions.some((position) => position < 0)) return;
    if (positions.some((position, index) => index > 0 && position <= positions[index - 1]!))
      issue(`${label} events are out of order.`);
  };

  const controlStart = exactlyOne("control", "started");
  const controlEnd = exactlyOne("control", "completed");
  const integrationStart = exactlyOne("integration", "started");
  const integrationEnd = exactlyOne("integration", "completed");
  if (controlStart !== 0 || controlEnd !== events.length - 1)
    issue("Control events must bracket all stage events.");
  ordered("Control/integration", [controlStart, integrationStart, integrationEnd, controlEnd]);
  const builders: number[] = [];
  const completions: number[] = [];
  let previousHandoff = controlStart;
  let repairCount = 0;
  for (const unit of unitIds) {
    const buildStart = exactlyOne("builder", "started", unit);
    const buildEnd = exactlyOne("builder", "completed", unit);
    const handoff = exactlyOne("handoff", "completed", unit);
    builders.push(buildStart);
    completions.push(buildEnd);
    ordered(`Builder/handoff for ${unit}`, [
      controlStart,
      buildStart,
      buildEnd,
      handoff,
      integrationStart,
    ]);
    if (!parallel) ordered(`Sequential handoff for ${unit}`, [previousHandoff, buildStart]);
    previousHandoff = handoff;
    if (review) {
      const reviewStart = exactlyOne("review", "started", unit);
      const reviewed = [
        ...indices("review", "passed", unit),
        ...indices("review", "differences-found", unit),
      ];
      if (reviewed.length !== 1)
        issue(`Expected one review outcome for ${unit}; found ${reviewed.length}.`);
      const reviewEnd = reviewed.length === 1 ? reviewed[0]! : -1;
      ordered(`Review for ${unit}`, [buildEnd, reviewStart, reviewEnd, handoff]);
      const repairStarts = indices("repair", "started", unit);
      const repairEnds = indices("repair", "completed", unit);
      repairCount += repairStarts.length;
      if (repairStarts.length || repairEnds.length) {
        if (repairStarts.length !== 1 || repairEnds.length !== 1)
          issue(`Expected one complete repair pair for ${unit}.`);
        if (indices("review", "differences-found", unit).length !== 1)
          issue(`Repair for ${unit} requires a preceding review difference.`);
        ordered(`Repair for ${unit}`, [
          reviewEnd,
          repairStarts[0] ?? -1,
          repairEnds[0] ?? -1,
          handoff,
        ]);
      }
    }
  }
  if (
    parallel &&
    builders.every((index) => index >= 0) &&
    completions.every((index) => index >= 0)
  ) {
    if (Math.max(...builders) >= Math.min(...completions))
      issue("Parallel control builders did not all start before any builder completed.");
  }
  if (response.attempts !== unitIds.length + repairCount)
    issue("Control attempt count must equal builder starts plus repair starts.");
  if (response.repairs !== repairCount)
    issue("Control repair count must equal its recorded repair stages.");
  if (repairCount > maxRepairs || (response.repairs !== null && response.repairs > maxRepairs))
    issue("Control exceeded the requested repair budget.");

  return reasons.length
    ? { status: "invalid", reasons: [...new Set(reasons)] }
    : {
        status: "verified-control",
        reasons: [
          "Harness-owned scripted stage structure, ordering, attempt counts and repair budget checked; no live model or framework execution is established.",
        ],
      };
}
