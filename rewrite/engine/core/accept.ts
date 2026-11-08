import {
  assignmentKey,
  digestValue,
  DomainError,
  type AcceptedTransition,
  type ArtifactRef,
  type Assignment,
  type AssignmentRef,
  type CallerAuthority,
  type CommandEnvelope,
  type FrozenWorker,
  type InboxMessage,
  type WorkerRequest,
} from "../contracts/index.ts";
import type { CoreState } from "./state.ts";
import { validateAssignmentGraph } from "./graph.ts";

export type AcceptanceOptions = {
  workers?: FrozenWorker[];
  config?: ArtifactRef;
  nextRevision?: number;
};

function requireWorker(state: CoreState, id: string): FrozenWorker {
  if (!Object.hasOwn(state.workers, id))
    throw new DomainError("invalid_input", `Unknown worker ${id}`, "worker");
  return state.workers[id];
}

function resolveReferences(
  state: CoreState,
  references: Array<string | AssignmentRef>,
  additions: ReadonlySet<string>,
): AssignmentRef[] {
  const resolved = references.map((reference) => {
    if (typeof reference === "string") {
      const assignment = additions.has(reference)
        ? 1
        : Object.hasOwn(state.latest, reference)
          ? state.latest[reference]
          : undefined;
      if (assignment === undefined)
        throw new DomainError(
          "dependency_missing",
          `Unknown dependency worker ${reference}`,
          "after",
        );
      return { run: state.run, worker: reference, assignment };
    }
    const exists =
      reference.run === state.run &&
      (Object.hasOwn(state.assignments, assignmentKey(reference)) ||
        (additions.has(reference.worker) && reference.assignment === 1));
    if (!exists)
      throw new DomainError(
        "dependency_missing",
        `Unknown dependency ${reference.run}/${reference.worker}/${reference.assignment}`,
        "after",
      );
    return structuredClone(reference);
  });
  return [...new Map(resolved.map((ref) => [assignmentKey(ref), ref])).values()];
}

function checkResolvedWorker(
  request: WorkerRequest,
  worker: FrozenWorker,
  caller: CallerAuthority,
): void {
  if (worker.id !== request.id || worker.agent !== request.agent)
    throw new DomainError("invalid_input", `Resolution does not match worker ${request.id}`);
  const grants = caller.grants;
  if (worker.access === "write" && grants.access !== "write")
    throw new DomainError(
      "capability_denied",
      `Write access is not granted to ${worker.id}`,
      "access",
    );
  if (worker.access !== worker.grants.access)
    throw new DomainError(
      "capability_denied",
      `Resolved access and grants disagree for ${worker.id}`,
      "access",
    );
  if (
    !grants.workspaces.includes(worker.workspace) ||
    !worker.grants.workspaces.includes(worker.workspace)
  )
    throw new DomainError(
      "capability_denied",
      `Workspace is not granted to ${worker.id}`,
      "workspace",
    );
  if (
    worker.tools.some(
      (tool) => !grants.tools.includes(tool) || !worker.grants.tools.includes(tool),
    ) ||
    worker.grants.tools.some((tool) => !grants.tools.includes(tool))
  )
    throw new DomainError(
      "capability_denied",
      `Tool capability exceeds the caller grant for ${worker.id}`,
      "tools",
    );
  if (
    (worker.grants.access === "write" && grants.access !== "write") ||
    worker.grants.workspaces.some((workspace) => !grants.workspaces.includes(workspace)) ||
    (worker.grants.inheritContext && !grants.inheritContext)
  )
    throw new DomainError(
      "capability_denied",
      `Worker grants exceed caller authority for ${worker.id}`,
    );
  if (
    worker.grants.memory.scope !== "none" &&
    (grants.memory.scope !== worker.grants.memory.scope ||
      (worker.grants.memory.access === "write" && grants.memory.access !== "write"))
  )
    throw new DomainError(
      "capability_denied",
      `Memory scope is not granted to ${worker.id}`,
      "memory",
    );
  const delegation = worker.grants.delegation;
  if (
    delegation.maxDepth > grants.delegation.maxDepth ||
    delegation.agents.some((agent) => !grants.delegation.agents.includes(agent)) ||
    delegation.tools.some((tool) => !grants.delegation.tools.includes(tool)) ||
    delegation.workspaces.some((workspace) => !grants.delegation.workspaces.includes(workspace))
  )
    throw new DomainError(
      "capability_denied",
      `Delegation exceeds caller authority for ${worker.id}`,
      "delegation",
    );
  for (const field of ["workspace", "backend", "lifetime"] as const) {
    if (request[field] !== undefined && request[field] !== worker[field])
      throw new DomainError(
        "unsupported",
        `Requested ${field} cannot be resolved for ${worker.id}`,
        field,
      );
  }
  if (request.model && digestValue(request.model) !== digestValue(worker.model ?? null))
    throw new DomainError(
      "unsupported",
      `Requested model cannot be resolved for ${worker.id}`,
      "model",
    );
  if (worker.backend === "in-process" && worker.lifetime === "surviving")
    throw new DomainError(
      "unsupported",
      "In-process execution cannot survive its host",
      "lifetime",
    );
  if (request.inheritContext === "parent" && !worker.grants.inheritContext)
    throw new DomainError("capability_denied", "Parent context is not granted", "inheritContext");
  if (
    request.memory &&
    request.memory.scope !== "none" &&
    (request.memory.scope !== worker.grants.memory.scope ||
      (request.memory.access === "write" && worker.grants.memory.access !== "write"))
  )
    throw new DomainError("capability_denied", "Requested memory access is not granted", "memory");
  if ((request.delegation?.maxDepth ?? 0) > worker.grants.delegation.maxDepth)
    throw new DomainError(
      "capability_denied",
      "Requested delegation depth is not granted",
      "delegation",
    );
}

function message(
  id: string,
  target: AssignmentRef,
  caller: CallerAuthority,
  kind: InboxMessage["kind"],
  text: string,
): InboxMessage {
  return { id, target, sender: caller.id, kind, text, state: "recorded", attempts: [] };
}

export function prepareCommand(
  state: CoreState,
  envelope: CommandEnvelope,
  caller: CallerAuthority,
  options: AcceptanceOptions = {},
): AcceptedTransition {
  if (caller.run !== state.run || caller.kind === "viewer")
    throw new DomainError("capability_denied", "Caller cannot mutate this run");
  if (caller.kind === "worker")
    throw new DomainError("unsupported", "Nested delegation requires the nesting runtime");
  if (envelope.expectedRevision !== undefined && envelope.expectedRevision !== state.revision)
    throw new DomainError(
      "conflict",
      `Expected revision ${envelope.expectedRevision}, current revision is ${state.revision}`,
      "expectedRevision",
    );
  if (Object.hasOwn(state.receipts, envelope.requestId))
    throw new DomainError(
      "conflict",
      "Request is already accepted; retrieve its existing receipt",
      "requestId",
    );
  const revision = options.nextRevision ?? state.revision + 1;
  if (revision !== state.revision + 1)
    throw new DomainError("conflict", "Acceptance revision must follow the current state");
  const command = envelope.command;
  const assignments: Assignment[] = [];
  const workers: FrozenWorker[] = [];
  const messages: InboxMessage[] = [];
  const firstSequence = state.nextSequence;
  switch (command.kind) {
    case "create":
    case "add": {
      if (command.kind === "create" && Object.keys(state.workers).length)
        throw new DomainError("conflict", "Run is already created");
      const names = new Set<string>();
      for (const request of command.workers) {
        if (Object.hasOwn(state.workers, request.id) || names.has(request.id))
          throw new DomainError("conflict", `Worker already exists: ${request.id}`, "id");
        names.add(request.id);
      }
      for (const request of command.workers) {
        const worker = options.workers?.find((resolved) => resolved.id === request.id);
        if (!worker)
          throw new DomainError(
            "invalid_input",
            `Definition was not resolved for ${request.id}`,
            "agent",
          );
        checkResolvedWorker(request, worker, caller);
        const ref = { run: state.run, worker: request.id, assignment: 1 };
        assignments.push({
          ref,
          sequence: firstSequence + assignments.length,
          task: request.task,
          after: resolveReferences(state, request.after, names),
          inputs: resolveReferences(state, request.inputs, new Set()),
          context: request.context,
          execution: { phase: "queued" },
        });
        workers.push(structuredClone(worker));
        messages.push(
          message(
            request.messageId ?? `${envelope.requestId}/${request.id}/initial`,
            ref,
            caller,
            "initial",
            request.task,
          ),
        );
      }
      break;
    }
    case "continue":
    case "follow_up": {
      requireWorker(state, command.worker);
      const previous = {
        run: state.run,
        worker: command.worker,
        assignment: state.latest[command.worker],
      };
      const ref = { ...previous, assignment: previous.assignment + 1 };
      if (command.kind === "continue") {
        const prior = state.assignments[assignmentKey(previous)];
        if (prior.execution.phase !== "ended" || prior.execution.cleanup !== "confirmed")
          throw new DomainError(
            "owner_unconfirmed",
            "Continue requires confirmed stopped work; attach to live work or reconcile uncertainty first",
            "worker",
          );
      }
      const after = resolveReferences(
        state,
        command.kind === "follow_up" ? command.after : [],
        new Set(),
      );
      if (!after.some((entry) => assignmentKey(entry) === assignmentKey(previous)))
        after.push(previous);
      assignments.push({
        ref,
        sequence: firstSequence,
        task: command.text,
        after,
        inputs: resolveReferences(
          state,
          command.kind === "follow_up" ? command.inputs : [],
          new Set(),
        ),
        context: [],
        execution: { phase: "queued" },
      });
      messages.push(message(command.messageId, ref, caller, "follow_up", command.text));
      break;
    }
    case "steer": {
      requireWorker(state, command.worker);
      const pending = Object.values(state.assignments)
        .filter(
          (assignment) =>
            assignment.ref.worker === command.worker && assignment.execution.phase !== "ended",
        )
        .sort((a, b) => a.ref.assignment - b.ref.assignment);
      const target =
        pending.find((assignment) => assignment.execution.phase !== "queued") ?? pending[0];
      if (!target)
        throw new DomainError(
          "invalid_input",
          "Worker is idle; use follow_up to accept a new assignment",
          "worker",
        );
      messages.push(message(command.messageId, target.ref, caller, "steer", command.text));
      break;
    }
    default:
      throw new DomainError(
        "unsupported",
        `Command ${command.kind} is not available in the acceptance service`,
      );
  }
  validateAssignmentGraph(state, assignments);
  const ids = new Set<string>();
  for (const entry of messages) {
    if (Object.hasOwn(state.inbox, entry.id) || ids.has(entry.id))
      throw new DomainError("conflict", `Message ID is already recorded: ${entry.id}`, "messageId");
    ids.add(entry.id);
  }
  const targets = assignments.length
    ? assignments.map((assignment) => assignment.ref)
    : messages.map((entry) => entry.target);
  return {
    kind: "accepted",
    requestId: envelope.requestId,
    payloadDigest: digestValue(envelope),
    receipt: {
      status: "accepted",
      requestId: envelope.requestId,
      revision,
      assignments: targets,
      resolved: targets.map((ref) => {
        const worker =
          workers.find((entry) => entry.id === ref.worker) ?? requireWorker(state, ref.worker);
        return {
          ref,
          workspace: worker.workspace,
          backend: worker.backend,
          lifetime: worker.lifetime,
          grants: structuredClone(worker.grants),
        };
      }),
    },
    ...(command.kind === "create"
      ? { maxConcurrent: command.config?.execution.maxConcurrent ?? null }
      : {}),
    workers,
    assignments,
    messages,
    ...(options.config ? { config: options.config } : {}),
  };
}
