import {
  childCommandEnvelopeSchema,
  childQuerySchema,
  childQueryResultSchema,
  childWaitSchema,
  type ChildPort,
  type ChildWaitResult,
} from "../contracts/delegation.ts";
import { assignmentKey, DomainError, type AssignmentRef } from "../contracts/common.ts";
import { type CoreState } from "../contracts/lifecycle.ts";
import { type CommandEnvelope } from "../contracts/commands.ts";
import { childAuthority, descendantWorkers } from "../core/delegation.ts";
import { occupiedAssignments } from "../core/readiness.ts";
import { type Runtime } from "./index.ts";
import { immutable } from "./immutable.ts";

type ChildRuntime = Pick<Runtime, "execute" | "query" | "wait">;

function awaitReply<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Child request wait aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class ChildBindings {
  private readonly runtime: ChildRuntime;
  private readonly snapshot: () => Promise<CoreState>;
  private readonly waiting = new Set<string>();
  constructor(runtime: ChildRuntime, snapshot: () => Promise<CoreState>) {
    this.runtime = runtime;
    this.snapshot = snapshot;
  }

  bind(parent: AssignmentRef): ChildPort {
    const bound = immutable(parent);
    const localRef = (ref: { worker: string; assignment: number }) => ({ run: bound.run, ...ref });
    const scopedId = (id: string) => `child:${assignmentKey(bound)}:${id}`;
    return {
      execute: async (input, signal) => {
        signal?.throwIfAborted();
        const request = childCommandEnvelopeSchema.parse(input);
        const state = await this.snapshot();
        const caller = childAuthority(state, bound);
        const command = request.command;
        let translated: CommandEnvelope["command"];
        switch (command.kind) {
          case "add":
            translated = {
              kind: "add",
              workers: command.workers.map((worker) => ({
                ...worker,
                origin: worker.origin ? localRef(worker.origin) : undefined,
                ...(worker.messageId ? { messageId: scopedId(worker.messageId) } : {}),
                after: worker.after.map((ref) => (typeof ref === "string" ? ref : localRef(ref))),
                inputs: worker.inputs.map(localRef),
              })),
            };
            break;
          case "follow_up":
            translated = {
              ...command,
              messageId: scopedId(command.messageId),
              after: command.after.map((ref) => (typeof ref === "string" ? ref : localRef(ref))),
              inputs: command.inputs.map(localRef),
            };
            break;
          case "steer":
            translated = { ...command, messageId: scopedId(command.messageId) };
            break;
          case "cancel":
            translated = command;
            break;
        }
        return awaitReply(
          this.runtime.execute(
            { requestId: scopedId(request.requestId), command: translated },
            caller,
          ),
          signal,
        );
      },
      query: async (input, signal) => {
        signal?.throwIfAborted();
        const query = childQuerySchema.parse(input);
        const state = await this.snapshot();
        const caller = childAuthority(state, bound);
        const descendants = descendantWorkers(state, bound.worker);
        if (query.kind === "status")
          return immutable({
            kind: "status",
            workers: Object.values(state.workers).filter((worker) => descendants.has(worker.id)),
            assignments: Object.values(state.assignments).filter((assignment) =>
              descendants.has(assignment.ref.worker),
            ),
            notices: Object.values(state.inbox).filter(
              (message) => message.kind === "notice" && message.target.worker === bound.worker,
            ),
            maxConcurrent: state.maxConcurrent,
          });
        if (!descendants.has(query.ref.worker))
          throw new DomainError(
            "capability_denied",
            "Child query targets a worker outside its parent's descendants",
          );
        return childQueryResultSchema.parse(
          await awaitReply(
            this.runtime.query({ ...query, ref: localRef(query.ref) }, caller),
            signal,
          ),
        );
      },
      wait: (input, signal) => this.wait(bound, input, signal),
    };
  }

  private async wait(
    parent: AssignmentRef,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ChildWaitResult> {
    const request = childWaitSchema.parse(input);
    const parentKey = assignmentKey(parent);
    this.waiting.add(parentKey);
    try {
      const state = await this.snapshot();
      const caller = childAuthority(state, parent);
      const descendants = descendantWorkers(state, parent.worker);
      const workers = request.workers ?? [...descendants];
      if (workers.some((worker) => !descendants.has(worker)))
        throw new DomainError(
          "capability_denied",
          "Child wait targets a worker outside its parent's descendants",
        );
      const selected = Object.values(state.assignments).filter(
        (assignment) =>
          workers.includes(assignment.ref.worker) && assignment.execution.phase !== "ended",
      );
      const queued = selected.filter((assignment) => assignment.execution.phase === "queued");
      const dependsOnParent = (initial: AssignmentRef): boolean => {
        const pending = [initial];
        const visited = new Set<string>();
        while (pending.length) {
          const ref = pending.pop();
          if (!ref) break;
          const key = assignmentKey(ref);
          if (key === parentKey) return true;
          if (visited.has(key)) continue;
          visited.add(key);
          const assignment = state.assignments[key];
          if (assignment && assignment.execution.phase !== "ended")
            pending.push(...assignment.after);
        }
        return false;
      };
      const occupied = occupiedAssignments(state);
      const dependencyBlocked = queued.some((assignment) => assignment.after.some(dependsOnParent));
      const capacityBlocked =
        queued.length > 0 &&
        state.maxConcurrent !== null &&
        occupied.length >= state.maxConcurrent &&
        occupied.every((assignment) => this.waiting.has(assignmentKey(assignment.ref)));
      if (dependencyBlocked || capacityBlocked)
        return {
          status: dependencyBlocked ? "dependency_blocked" : "capacity_blocked",
          targets: selected.map((assignment) => assignment.ref),
          results: [],
          cursor: state.revision,
          guidance:
            "Inspect child status without blocking, then finish this parent assignment to release its ordering/capacity slot. The coordinator can explicitly continue it after the children finish.",
        };
      return await this.runtime.wait({ workers, next: request.next }, caller, signal);
    } finally {
      this.waiting.delete(parentKey);
    }
  }
}
