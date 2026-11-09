import {
  assignmentKey,
  digestValue,
  DomainError,
  type AcceptedTransition,
  type CoreState,
} from "../contracts/index.ts";
import { validateAssignmentGraph } from "./graph.ts";
import { validateChildWorker } from "./delegation.ts";

export function validateAcceptance(
  state: CoreState,
  transition: AcceptedTransition,
  revision: number,
): void {
  const receipt = transition.receipt;
  if (
    receipt.revision !== revision ||
    receipt.requestId !== transition.requestId ||
    Object.hasOwn(state.receipts, transition.requestId)
  )
    throw new DomainError("conflict", "Invalid accepted receipt identity");
  const additions = new Map(
    transition.assignments.map((assignment) => [assignmentKey(assignment.ref), assignment]),
  );
  const newWorkers = new Map(transition.workers.map((worker) => [worker.id, worker]));
  if (
    newWorkers.size !== transition.workers.length ||
    additions.size !== transition.assignments.length
  )
    throw new DomainError("conflict", "Acceptance repeats a worker or assignment identity");
  for (const worker of transition.workers) {
    validateChildWorker(state, worker);
    if (
      worker.origin &&
      (worker.origin.run !== state.run ||
        !Object.hasOwn(state.assignments, assignmentKey(worker.origin)))
    )
      throw new DomainError(
        "conflict",
        "Replacement origin is not an existing assignment in this run",
      );
    if (
      Object.hasOwn(state.workers, worker.id) ||
      !additions.has(assignmentKey({ run: state.run, worker: worker.id, assignment: 1 }))
    )
      throw new DomainError("conflict", "New worker lacks its first accepted assignment");
  }
  const assignmentWorkers = new Set<string>();
  for (const assignment of transition.assignments) {
    const ref = assignment.ref;
    if (assignmentWorkers.has(ref.worker))
      throw new DomainError("conflict", "Acceptance repeats a worker assignment");
    assignmentWorkers.add(ref.worker);
    const latest = Object.hasOwn(state.latest, ref.worker) ? state.latest[ref.worker] : 0;
    if (
      ref.run !== state.run ||
      ref.assignment !== latest + 1 ||
      assignment.execution.phase !== "queued"
    )
      throw new DomainError(
        "conflict",
        "Accepted assignment has invalid identity or execution state",
      );
    if (latest === 0 && !newWorkers.has(ref.worker))
      throw new DomainError("conflict", "First assignment lacks a frozen worker");
    if (
      latest > 0 &&
      !assignment.after.some(
        (dependency) =>
          dependency.run === state.run &&
          dependency.worker === ref.worker &&
          dependency.assignment === latest,
      )
    )
      throw new DomainError("conflict", "Follow-up lacks its immutable FIFO predecessor");
    for (const input of assignment.inputs) {
      if (!Object.hasOwn(state.assignments, assignmentKey(input)))
        throw new DomainError(
          "dependency_missing",
          "Accepted input references an unknown assignment",
          "inputs",
        );
    }
    const messages = transition.messages.filter(
      (message) => assignmentKey(message.target) === assignmentKey(ref),
    );
    const expectedKind = latest === 0 ? "initial" : "follow_up";
    if (
      messages.length !== 1 ||
      messages[0].kind !== expectedKind ||
      messages[0].text !== assignment.task
    )
      throw new DomainError("conflict", "Assignment and initial inbox message disagree");
  }
  if (
    !transition.assignments.length &&
    (transition.workers.length ||
      transition.messages.length !== 1 ||
      transition.messages[0].kind !== "steer")
  )
    throw new DomainError("conflict", "Message-only acceptance must be one steering message");
  for (const message of transition.messages) {
    if (
      message.state !== "recorded" ||
      message.attempts.length ||
      Object.hasOwn(state.inbox, message.id)
    )
      throw new DomainError(
        "conflict",
        "New inbox message has prior identity or dispatch evidence",
      );
    if (transition.assignments.length && !additions.has(assignmentKey(message.target)))
      throw new DomainError("conflict", "Initial inbox message targets a different assignment");
    if (!transition.assignments.length) {
      const assignment = state.assignments[assignmentKey(message.target)];
      if (!assignment || assignment.execution.phase === "ended")
        throw new DomainError("conflict", "Steering targets unknown or ended work");
    }
  }
  validateAssignmentGraph(state, transition.assignments);
  const targets = transition.assignments.length
    ? transition.assignments.map((assignment) => assignment.ref)
    : transition.messages.map((message) => message.target);
  if (
    digestValue(receipt.assignments) !== digestValue(targets) ||
    receipt.resolved.length !== targets.length
  )
    throw new DomainError("conflict", "Receipt targets disagree with accepted work");
  for (const [index, target] of targets.entries()) {
    const worker =
      newWorkers.get(target.worker) ??
      (Object.hasOwn(state.workers, target.worker) ? state.workers[target.worker] : undefined);
    if (!worker) throw new DomainError("conflict", "Receipt targets a missing worker");
    const resolved = {
      ref: target,
      workspace: worker.workspace,
      backend: worker.backend,
      lifetime: worker.lifetime,
      grants: worker.grants,
    };
    if (digestValue(receipt.resolved[index]) !== digestValue(resolved))
      throw new DomainError(
        "conflict",
        "Receipt resolved settings disagree with the frozen worker",
      );
  }
}
