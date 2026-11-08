import {
  assignmentKey,
  digestValue,
  DomainError,
  type AssignmentRef,
  type CallerAuthority,
  type CommandEnvelope,
  type ControlTransition,
  type CoreState,
} from "../contracts/index.ts";

export function prepareControl(
  state: CoreState,
  envelope: CommandEnvelope,
  caller: CallerAuthority,
): ControlTransition {
  if (caller.run !== state.run || caller.kind !== "coordinator")
    throw new DomainError("capability_denied", "Caller cannot control this run");
  if (envelope.expectedRevision !== undefined && envelope.expectedRevision !== state.revision)
    throw new DomainError("conflict", "Control request has a stale revision", "expectedRevision");
  if (Object.hasOwn(state.receipts, envelope.requestId))
    throw new DomainError("conflict", "Control request is already accepted", "requestId");
  const command = envelope.command;
  let targets: AssignmentRef[] = [];
  if (command.kind === "cancel") {
    if (
      command.scope !== "run" &&
      (!command.worker || !Object.hasOwn(state.workers, command.worker))
    )
      throw new DomainError("invalid_input", "Cancellation requires a known worker", "worker");
    if (
      command.scope === "assignment" &&
      (!command.assignment ||
        !command.worker ||
        !Object.hasOwn(
          state.assignments,
          assignmentKey({ run: state.run, worker: command.worker, assignment: command.assignment }),
        ))
    )
      throw new DomainError(
        "invalid_input",
        "Cancellation requires a known exact assignment",
        "assignment",
      );
    if (command.scope !== "assignment" && command.assignment !== undefined)
      throw new DomainError(
        "invalid_input",
        "assignment is only valid with assignment scope",
        "assignment",
      );
    if (command.scope === "run" && command.worker !== undefined)
      throw new DomainError("invalid_input", "worker is not valid with run scope", "worker");
    const selected = Object.values(state.assignments).filter(
      (assignment) =>
        command.scope === "run" ||
        (assignment.ref.worker === command.worker &&
          (command.scope === "worker" || assignment.ref.assignment === command.assignment)),
    );
    const selectedKeys = new Set(selected.map((assignment) => assignmentKey(assignment.ref)));
    if (command.descendants || command.scope === "run") {
      let changed = true;
      while (changed) {
        changed = false;
        for (const assignment of Object.values(state.assignments)) {
          const parent = state.workers[assignment.ref.worker].parentAssignment;
          const key = assignmentKey(assignment.ref);
          if (parent && selectedKeys.has(assignmentKey(parent)) && !selectedKeys.has(key)) {
            selectedKeys.add(key);
            changed = true;
          }
        }
      }
    }
    targets = Object.values(state.assignments)
      .filter(
        (assignment) =>
          selectedKeys.has(assignmentKey(assignment.ref)) &&
          (assignment.execution.phase !== "ended" ||
            assignment.execution.cleanup === "unconfirmed"),
      )
      .map((assignment) => assignment.ref);
  } else if (command.kind !== "background")
    throw new DomainError("unsupported", `${command.kind} is not a lifecycle control`);
  return {
    kind: "control_accepted",
    requestId: envelope.requestId,
    payloadDigest: digestValue(envelope),
    action: command.kind === "cancel" ? { kind: "cancel", targets } : { kind: "background" },
    receipt: {
      status: "accepted",
      requestId: envelope.requestId,
      revision: state.revision + 1,
      assignments: structuredClone(targets),
      resolved: targets.map((ref) => {
        const worker = state.workers[ref.worker];
        return {
          ref: structuredClone(ref),
          workspace: worker.workspace,
          backend: worker.backend,
          lifetime: worker.lifetime,
          grants: structuredClone(worker.grants),
        };
      }),
    },
  };
}
