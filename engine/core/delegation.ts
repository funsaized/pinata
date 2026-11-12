import {
  assignmentKey,
  DomainError,
  type AssignmentRef,
  type CallerAuthority,
  type CoreState,
  type FrozenWorker,
  type RuntimeCommand,
} from "../contracts/index.ts";
import { digestValue } from "../contracts/digest.ts";
import { assignmentAttempts } from "./indexes.ts";

export function descendantWorkers(state: CoreState, parent: string): Set<string> {
  const descendants = new Set<string>();
  for (;;) {
    let added = false;
    for (const worker of Object.values(state.workers)) {
      const ancestor = worker.parentAssignment?.worker;
      if (
        ancestor &&
        (ancestor === parent || descendants.has(ancestor)) &&
        !descendants.has(worker.id)
      ) {
        descendants.add(worker.id);
        added = true;
      }
    }
    if (!added) return descendants;
  }
}

export function childAuthority(state: CoreState, parent: AssignmentRef): CallerAuthority {
  const key = assignmentKey(parent);
  const assignment = state.assignments[key];
  const worker = state.workers[parent.worker];
  // A backend may begin its first turn before start() returns. Enrollment is
  // durable before tools become available, so that boundary is also active.
  const enrolled =
    assignment?.execution.phase === "preparing" &&
    assignmentAttempts(state, key).some((entry) => entry.identity && !entry.cleanup);
  if (
    parent.run !== state.run ||
    !assignment ||
    !worker ||
    (assignment.execution.phase !== "running" && !enrolled) ||
    Object.hasOwn(state.cancelled, key)
  )
    throw new DomainError(
      "capability_denied",
      "Child commands require the bound parent assignment to be running and uncancelled",
    );
  const delegated = worker.grants.delegation;
  if (!delegated.maxDepth)
    throw new DomainError("capability_denied", "Nested delegation is disabled for this worker");
  return {
    id: `worker:${key}`,
    kind: "worker",
    run: state.run,
    parentAssignment: structuredClone(parent),
    grants: {
      access: worker.grants.access,
      tools: [...delegated.tools],
      workspaces: [...delegated.workspaces],
      inheritContext: worker.grants.inheritContext,
      memory: { scope: "none", access: "read" },
      delegation: {
        maxDepth: delegated.maxDepth - 1,
        agents: [...delegated.agents],
        tools: [...delegated.tools],
        workspaces: [...delegated.workspaces],
      },
    },
  };
}

export function checkChildCaller(state: CoreState, caller: CallerAuthority): void {
  if (
    !caller.parentAssignment ||
    digestValue(childAuthority(state, caller.parentAssignment)) !== digestValue(caller)
  )
    throw new DomainError(
      "capability_denied",
      "Worker authority differs from its bound parent assignment",
    );
}

export function checkChildCommand(
  state: CoreState,
  caller: CallerAuthority,
  command: RuntimeCommand,
): void {
  checkChildCaller(state, caller);
  const parent = caller.parentAssignment;
  if (!parent)
    throw new DomainError("capability_denied", "Child caller lacks its parent assignment");
  const descendants = descendantWorkers(state, parent.worker);
  const allowed = (worker: string) => {
    if (!descendants.has(worker))
      throw new DomainError(
        "capability_denied",
        "Child control is limited to the parent's descendants",
        "worker",
      );
  };
  switch (command.kind) {
    case "add": {
      const parentWorker = state.workers[parent.worker];
      const additions = new Set(command.workers.map((worker) => worker.id));
      for (const request of command.workers) {
        if (!parentWorker.grants.delegation.agents.includes(request.agent))
          throw new DomainError(
            "capability_denied",
            `Child definition is not delegated: ${request.agent}`,
            "agent",
          );
        for (const reference of [
          ...request.after,
          ...request.inputs,
          ...(request.origin ? [request.origin] : []),
        ]) {
          const worker = typeof reference === "string" ? reference : reference.worker;
          if (typeof reference !== "string" && reference.run !== state.run)
            throw new DomainError("capability_denied", "Child references cannot name another run");
          if (!additions.has(worker) && worker !== parent.worker) allowed(worker);
        }
      }
      return;
    }
    case "follow_up":
      allowed(command.worker);
      for (const reference of [...command.after, ...command.inputs]) {
        if (typeof reference !== "string" && reference.run !== state.run)
          throw new DomainError("capability_denied", "Child references cannot name another run");
        const worker = typeof reference === "string" ? reference : reference.worker;
        if (worker !== parent.worker) allowed(worker);
      }
      return;
    case "steer":
      allowed(command.worker);
      return;
    case "cancel":
      if (command.scope === "run" || !command.worker)
        throw new DomainError("capability_denied", "Workers cannot cancel the root run");
      allowed(command.worker);
      return;
    default:
      throw new DomainError("capability_denied", `Workers cannot issue ${command.kind} commands`);
  }
}

export function validateChildWorker(state: CoreState, worker: FrozenWorker): void {
  if (!worker.parentAssignment) {
    if (worker.depth !== 0) throw new DomainError("conflict", "A root worker must have depth zero");
    return;
  }
  const parent = state.workers[worker.parentAssignment.worker];
  const caller = childAuthority(state, worker.parentAssignment);
  if (
    !parent.grants.delegation.agents.includes(worker.agent) ||
    worker.depth !== parent.depth + 1 ||
    (worker.grants.access === "write" && caller.grants.access !== "write") ||
    worker.tools.some((tool) => !caller.grants.tools.includes(tool)) ||
    !caller.grants.workspaces.includes(worker.workspace) ||
    worker.grants.delegation.maxDepth > caller.grants.delegation.maxDepth ||
    worker.grants.delegation.agents.some(
      (agent) => !caller.grants.delegation.agents.includes(agent),
    ) ||
    worker.grants.delegation.tools.some((tool) => !caller.grants.delegation.tools.includes(tool)) ||
    worker.grants.delegation.workspaces.some(
      (workspace) => !caller.grants.delegation.workspaces.includes(workspace),
    ) ||
    worker.grants.memory.scope !== "none" ||
    (worker.grants.inheritContext && !caller.grants.inheritContext)
  )
    throw new DomainError(
      "capability_denied",
      "Child worker exceeds its frozen parent delegation grant",
    );
}
