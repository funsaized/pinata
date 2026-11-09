import { assignmentKey, DomainError, type CallerAuthority } from "../contracts/common.ts";
import { digestValue } from "../contracts/digest.ts";
import type { CoreState, Transition } from "../contracts/lifecycle.ts";
import { checkResolvedWorker } from "./accept.ts";
import { validateAssignmentGraph } from "./graph.ts";

export function importHistory(
  state: CoreState,
  transition: Extract<Transition, { kind: "history_imported" }>,
  revision: number,
): CoreState {
  if (
    state.revision !== 0 ||
    Object.keys(state.workers).length ||
    Object.keys(state.assignments).length ||
    state.history
  )
    throw new DomainError("conflict", "Historical import requires an empty new run");
  if (
    transition.receipt.requestId !== transition.requestId ||
    transition.receipt.revision !== revision
  )
    throw new DomainError("conflict", "Historical import receipt identity disagrees");
  const workers: CoreState["workers"] = {};
  const assignments: CoreState["assignments"] = {};
  const latest: CoreState["latest"] = {};
  const results: CoreState["results"] = {};
  let sequence = 1;
  for (const { worker, sourceGrants, provenance } of transition.workers) {
    if (Object.hasOwn(workers, worker.id) || provenance.run === state.run)
      throw new DomainError(
        "conflict",
        "Historical worker identity is duplicated or lacks a new origin",
      );
    const sourceCaller: CallerAuthority = {
      id: "historical-source",
      kind: "coordinator",
      run: state.run,
      grants: sourceGrants,
    };
    checkResolvedWorker(
      {
        id: worker.id,
        agent: worker.agent,
        task: "Imported history",
        after: [],
        inputs: [],
        context: [],
      },
      worker,
      sourceCaller,
    );
    if (
      worker.grants.memory.scope !== "none" ||
      worker.grants.inheritContext ||
      worker.grants.delegation.maxDepth !== 0 ||
      worker.parentAssignment ||
      worker.context ||
      worker.lifetime !== "attached"
    )
      throw new DomainError(
        "capability_denied",
        "Historical import cannot activate new context, memory, delegation or surviving work",
      );
    Object.defineProperty(workers, worker.id, {
      value: worker,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const entry of transition.assignments) {
    const { assignment, result } = entry;
    const key = assignmentKey(assignment.ref);
    if (
      assignment.ref.run !== state.run ||
      !Object.hasOwn(workers, assignment.ref.worker) ||
      Object.hasOwn(assignments, key) ||
      assignment.sequence !== sequence++
    )
      throw new DomainError("conflict", "Historical assignment identities or ordering are invalid");
    if (
      !assignment.historical ||
      !result.historical ||
      assignment.historical.run === state.run ||
      digestValue(assignment.historical) !== digestValue(result.historical) ||
      digestValue(assignment.ref) !== digestValue(result.ref) ||
      digestValue(assignment.execution) !== digestValue(result.execution)
    )
      throw new DomainError(
        "conflict",
        "Imported assignment/result lacks matching historical provenance",
      );
    if (
      assignment.execution.phase !== "ended" ||
      assignment.execution.cleanup !== "confirmed" ||
      result.usage.complete ||
      result.usage.observations.length ||
      result.usage.expectedAttempts.length
    )
      throw new DomainError(
        "conflict",
        "Historical observations must remain inert and cannot attest new execution or accounting",
      );
    assignments[key] = assignment;
    latest[assignment.ref.worker] = Math.max(
      Object.hasOwn(latest, assignment.ref.worker) ? latest[assignment.ref.worker] : 0,
      assignment.ref.assignment,
    );
    results[key] = { result, artifact: entry.resultArtifact };
  }
  for (const id of Object.keys(workers))
    if (!Object.hasOwn(latest, id))
      throw new DomainError("conflict", "Historical worker lacks an observed assignment");
  const next: CoreState = {
    ...state,
    revision,
    workers,
    assignments,
    latest,
    results,
    nextSequence: sequence,
    history: {
      source: transition.source,
      quiescence: transition.quiescence,
      requestId: transition.requestId,
    },
    receipts: {
      [transition.requestId]: {
        payloadDigest: transition.payloadDigest,
        receipt: transition.receipt,
      },
    },
    sessions: {},
  };
  validateAssignmentGraph({ ...state, workers }, Object.values(assignments));
  for (const assignment of Object.values(assignments))
    for (const input of assignment.inputs)
      if (!Object.hasOwn(assignments, assignmentKey(input)))
        throw new DomainError(
          "dependency_missing",
          "Historical snapshot input references an unobserved assignment",
        );
  for (const checkpoint of transition.sessions) {
    if (
      !Object.hasOwn(workers, checkpoint.worker) ||
      Object.hasOwn(next.sessions, checkpoint.worker)
    )
      throw new DomainError("conflict", "Historical session names an unknown or repeated worker");
    next.sessions[checkpoint.worker] = checkpoint;
  }
  const refs = transition.assignments.map((entry) => entry.assignment.ref);
  const resolved = refs.map((ref) => {
    const worker = workers[ref.worker];
    return {
      ref,
      workspace: worker.workspace,
      backend: worker.backend,
      lifetime: worker.lifetime,
      grants: worker.grants,
    };
  });
  if (
    digestValue(refs) !== digestValue(transition.receipt.assignments) ||
    digestValue(resolved) !== digestValue(transition.receipt.resolved)
  )
    throw new DomainError("conflict", "Historical receipt does not describe imported assignments");
  return next;
}
