import {
  assignmentKey,
  DomainError,
  type CallerAuthority,
  type CommandEnvelope,
  type CoreState,
  type Transition,
} from "../contracts/index.ts";
import { type ApplicationCommand, type ApplicationIntent } from "../contracts/application.ts";
import { digestValue } from "../contracts/digest.ts";

type ApplicationTransition = Extract<
  Transition,
  { kind: "application_accepted" | "application_observed" }
>;

export function prepareApplication(
  state: CoreState,
  request: CommandEnvelope & { command: ApplicationCommand },
  caller: CallerAuthority,
  identity: { operationId: string; ownerEpoch: string },
): Extract<ApplicationTransition, { kind: "application_accepted" }> {
  if (caller.kind !== "coordinator" || caller.run !== state.run || caller.grants.access !== "write")
    throw new DomainError(
      "capability_denied",
      "Application requires explicit coordinator write authority",
    );
  if (request.expectedRevision !== undefined && request.expectedRevision !== state.revision)
    throw new DomainError(
      "conflict",
      "Expected runtime revision does not match",
      "expectedRevision",
    );
  const command = request.command;
  let intent: ApplicationIntent;
  if (command.kind === "apply") {
    const result = state.results[assignmentKey(command.ref)]?.result;
    if (command.ref.run !== state.run || !result?.snapshot)
      throw new DomainError(
        "context_unavailable",
        "Assignment has no retained workspace snapshot to apply",
      );
    if (result.execution.phase !== "ended" || result.execution.cleanup !== "confirmed")
      throw new DomainError(
        "owner_unconfirmed",
        "Application requires confirmed cleanup of the snapshot producer",
      );
    intent = {
      id: identity.operationId,
      requestId: request.requestId,
      command,
      ownerEpoch: identity.ownerEpoch,
      destination: command.destination,
      ref: command.ref,
      snapshot: result.snapshot,
    };
  } else {
    const target = Object.hasOwn(state.applications, command.operation)
      ? state.applications[command.operation]
      : undefined;
    if (!target)
      throw new DomainError("invalid_input", "Unknown application operation", "operation");
    if (command.kind === "rollback" && (target.status !== "completed" || !target.receipt))
      throw new DomainError("conflict", "Rollback requires a completed application receipt");
    if (command.kind === "rollback" && command.destination !== target.intent.destination)
      throw new DomainError(
        "conflict",
        "Rollback destination differs from its recorded application",
      );
    if (command.kind === "reconcile" && command.owner !== target.intent.ownerEpoch)
      throw new DomainError(
        "owner_unconfirmed",
        "Reconciliation owner differs from the recorded operation epoch",
      );
    intent = {
      id: identity.operationId,
      requestId: request.requestId,
      command,
      ownerEpoch: identity.ownerEpoch,
      destination: target.intent.destination,
      ref: target.intent.ref,
      snapshot: target.intent.snapshot,
      targetOperation: target.receipt?.operationId ?? target.intent.id,
    };
  }
  const worker = state.workers[intent.ref.worker];
  if (!worker) throw new DomainError("conflict", "Application source worker is unavailable");
  return {
    kind: "application_accepted",
    requestId: request.requestId,
    payloadDigest: digestValue(request),
    intent,
    receipt: {
      status: "accepted",
      requestId: request.requestId,
      revision: state.revision + 1,
      operationId: intent.id,
      assignments: [intent.ref],
      resolved: [
        {
          ref: intent.ref,
          workspace: worker.workspace,
          backend: worker.backend,
          lifetime: worker.lifetime,
          grants: worker.grants,
        },
      ],
    },
  };
}

export function reduceApplication(
  state: CoreState,
  transition: ApplicationTransition,
  revision: number,
): CoreState {
  if (transition.kind === "application_accepted") {
    const { intent, receipt } = transition;
    const source = state.results[assignmentKey(intent.ref)]?.result;
    const worker = state.workers[intent.ref.worker];
    if (source?.execution.phase !== "ended" || source.execution.cleanup !== "confirmed")
      throw new DomainError("conflict", "Application source lacks confirmed final cleanup");
    if (intent.command.kind === "apply") {
      if (
        digestValue(intent.command.ref) !== digestValue(intent.ref) ||
        intent.command.destination !== intent.destination ||
        intent.targetOperation
      )
        throw new DomainError("conflict", "Application command disagrees with its frozen intent");
    } else {
      const target = state.applications[intent.command.operation];
      if (
        !target ||
        digestValue(target.intent.ref) !== digestValue(intent.ref) ||
        digestValue(target.intent.snapshot) !== digestValue(intent.snapshot) ||
        target.intent.destination !== intent.destination ||
        intent.targetOperation !== (target.receipt?.operationId ?? target.intent.id)
      )
        throw new DomainError(
          "conflict",
          "Application control target disagrees with its frozen intent",
        );
      if (
        intent.command.kind === "rollback" &&
        (target.status !== "completed" ||
          !target.receipt ||
          intent.command.destination !== intent.destination)
      )
        throw new DomainError("conflict", "Rollback source is not a completed application");
      if (intent.command.kind === "reconcile" && intent.command.owner !== target.intent.ownerEpoch)
        throw new DomainError(
          "owner_unconfirmed",
          "Application reconciliation names a different owner",
        );
    }
    const expected = worker
      ? [
          {
            ref: intent.ref,
            workspace: worker.workspace,
            backend: worker.backend,
            lifetime: worker.lifetime,
            grants: worker.grants,
          },
        ]
      : [];
    if (
      receipt.requestId !== transition.requestId ||
      receipt.revision !== revision ||
      receipt.operationId !== intent.id ||
      intent.requestId !== transition.requestId ||
      Object.hasOwn(state.applications, intent.id) ||
      Object.hasOwn(state.receipts, transition.requestId) ||
      !source?.snapshot ||
      digestValue(source.snapshot) !== digestValue(intent.snapshot) ||
      digestValue(receipt.assignments) !== digestValue([intent.ref]) ||
      digestValue(receipt.resolved) !== digestValue(expected)
    )
      throw new DomainError(
        "conflict",
        "Application intent, source, or acceptance receipt is inconsistent",
      );
    return {
      ...state,
      revision,
      applications: { ...state.applications, [intent.id]: { intent, status: "pending" } },
      receipts: {
        ...state.receipts,
        [transition.requestId]: { payloadDigest: transition.payloadDigest, receipt },
      },
    };
  }
  const entry = state.applications[transition.operationId];
  if (!entry || entry.status !== "pending")
    throw new DomainError("conflict", "Application observation does not name a pending operation");
  const observation = transition.observation;
  if (
    !observation.evidence ||
    (observation.status === "completed"
      ? !Object.hasOwn(observation, "receipt") || !!observation.error
      : !observation.error || observation.receipt !== undefined)
  )
    throw new DomainError(
      "conflict",
      "Application observation lacks its immutable result evidence",
    );
  if (
    observation.status === "completed" &&
    observation.receipt === null &&
    entry.intent.command.kind !== "reconcile"
  )
    throw new DomainError(
      "conflict",
      "Only reconciliation can confirm an absent application operation",
    );
  if (
    observation.receipt &&
    entry.intent.command.kind === "reconcile" &&
    observation.receipt.operationId !== entry.intent.targetOperation
  )
    throw new DomainError("conflict", "Reconciliation receipt names a different target operation");
  if (
    observation.receipt &&
    entry.intent.command.kind === "rollback" &&
    observation.receipt.operationId !== entry.intent.id
  )
    throw new DomainError("conflict", "Rollback receipt changed its operation identity");
  if (
    observation.receipt &&
    (observation.receipt.destination !== entry.intent.destination ||
      digestValue(observation.receipt.snapshot) !== digestValue(entry.intent.snapshot))
  )
    throw new DomainError("conflict", "Application receipt disagrees with its intent");
  return {
    ...state,
    revision,
    applications: { ...state.applications, [transition.operationId]: { ...entry, ...observation } },
  };
}
