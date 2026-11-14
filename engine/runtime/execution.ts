import {
  backendObservationSchema,
  backendObservationSourceSchema,
  backendOutcomeSchema,
  cleanupReceiptSchema,
  preparedWorkspaceSchema,
  sessionCheckpointSchema,
  transportReceiptSchema,
  workspaceCaptureSchema,
  PreparationFailure,
  BackendStartFailure,
  type ArtifactPort,
  type BackendHandle,
  type BackendObservation,
  type ObservationSource,
  type BackendOutcome,
  type BackendPort,
  type CleanupReceipt,
  type PreparedWorkspace,
  type SessionCheckpoint,
  type WorkspaceCapture,
  type WorkspacePort,
} from "../contracts/backend.ts";
import {
  assignmentKey,
  DomainError,
  type ArtifactRef,
  type AssignmentRef,
} from "../contracts/common.ts";
import type { FrozenWorker, RuntimeCommand } from "../contracts/commands.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import type {
  Assignment,
  AssignmentResult,
  AttemptState,
  CoreState,
  InboxMessage,
  Transition,
} from "../contracts/lifecycle.ts";
import type { RecoveryReceipt } from "../contracts/runtime.ts";
import { readyAssignments } from "../core/readiness.ts";
import {
  assignmentAttempts,
  assignmentEffects,
  hasQueuedAssignments,
  occupiedAssignments,
  occupiedCount,
  queuedAssignments,
} from "../core/indexes.ts";
import { dependencyResults } from "../core/state.ts";
import { assignmentUsage } from "../core/usage.ts";
import { verifyConversationArtifact } from "../storage/conversation.ts";
import { immutable } from "./immutable.ts";

export type ExecutionTransaction = {
  state(): CoreState;
  commitAll(transitions: readonly Transition[]): Promise<void>;
  commit(
    transition: Transition,
    identity?: { requestId: string; payloadDigest: string },
  ): Promise<void>;
};

export type ExecutionHost = {
  directory: string;
  ownerEpoch: string;
  artifacts: ArtifactPort;
  transaction<T>(operation: (transaction: ExecutionTransaction) => Promise<T>): Promise<T>;
  assertOwner(): Promise<void>;
  activity(
    ref: AssignmentRef,
    observation: Extract<BackendObservation, { kind: "activity" }>,
  ): void;
  diagnostic(message: string): void;
};

export type ExecutionOptions = {
  backends: Partial<Record<BackendPort["kind"], BackendPort>>;
  workspace: WorkspacePort;
};

type StopReceipt = Awaited<ReturnType<BackendHandle["stop"]>>;
type SelectedInput = { ref: AssignmentRef; stored: CoreState["results"][string] | undefined };
type ActiveAssignment = {
  assignment: Assignment;
  worker: FrozenWorker;
  attemptId: string;
  ownerEpoch: string;
  recovered: boolean;
  controller: AbortController;
  prepared?: PreparedWorkspace;
  handle?: BackendHandle;
  stop?: Promise<StopReceipt>;
  stopped: Promise<StopReceipt>;
  resolveStopped: (receipt: StopReceipt) => void;
  sending: Set<string>;
  launchInvoked: boolean;
};

// Owns live resources; every authority change still goes through Runtime's short
// transaction queue. No provider or cleanup wait holds that queue.
export class ExecutionCoordinator {
  private readonly host: ExecutionHost;
  private readonly options: ExecutionOptions;
  private readonly active = new Map<string, ActiveAssignment>();
  private readonly tasks = new Set<Promise<void>>();
  private pumpScheduled = false;
  private pumping = false;
  private closing = false;
  private halted = false;

  constructor(host: ExecutionHost, options: ExecutionOptions) {
    this.host = host;
    this.options = options;
  }

  async checkpoint(ref: AssignmentRef): Promise<SessionCheckpoint | undefined> {
    const active = this.active.get(assignmentKey(ref));
    if (!active?.handle) return undefined;
    await this.host.assertOwner();
    const checkpoint = sessionCheckpointSchema.parse(await active.handle.checkpoint());
    if (checkpoint.worker !== ref.worker)
      throw new DomainError("context_unavailable", "Live checkpoint belongs to another worker");
    await verifyConversationArtifact(checkpoint.artifact, this.host.artifacts);
    await this.host.assertOwner();
    return checkpoint;
  }

  validateWorkers(workers: FrozenWorker[]): void {
    for (const worker of workers) {
      const backend = this.options.backends[worker.backend];
      if (!backend?.capabilities.available)
        throw new DomainError(
          "unsupported",
          backend?.capabilities.reason ?? `Backend ${worker.backend} is not available`,
          "backend",
        );
      if (worker.grants.delegation.maxDepth && !backend.capabilities.delegation)
        throw new DomainError(
          "unsupported",
          `Backend ${worker.backend} cannot host scoped child commands`,
          "delegation",
        );
      if (worker.context && !backend.capabilities.conversationSeed)
        throw new DomainError(
          "unsupported",
          `Backend ${worker.backend} cannot import the requested parent conversation`,
          "inheritContext",
        );
      if (worker.lifetime === "surviving" && !backend.capabilities.surviving)
        throw new DomainError(
          "unsupported",
          `Backend ${worker.backend} cannot preserve detached execution`,
          "lifetime",
        );
    }
  }

  async validateCommand(command: RuntimeCommand, state: CoreState): Promise<void> {
    if (command.kind !== "follow_up" && command.kind !== "continue" && command.kind !== "steer")
      return;
    const worker = Object.hasOwn(state.workers, command.worker)
      ? state.workers[command.worker]
      : undefined;
    if (!worker) return;
    const backend = this.options.backends[worker.backend];
    if (!backend?.capabilities.available)
      throw new DomainError("unsupported", `Backend ${worker.backend} is not available`, "backend");
    if (command.kind !== "steer" && !backend.capabilities.continuation)
      throw new DomainError(
        "unsupported",
        `Backend ${worker.backend} cannot restore a saved conversation`,
        "worker",
      );
    if (command.kind !== "steer") {
      const latest =
        state.assignments[
          assignmentKey({ run: state.run, worker: worker.id, assignment: state.latest[worker.id] })
        ];
      if (latest.execution.phase === "ended") {
        const checkpoint = Object.hasOwn(state.sessions, worker.id)
          ? state.sessions[worker.id]
          : undefined;
        if (!checkpoint)
          throw new DomainError(
            "context_unavailable",
            "Saved worker conversation is unavailable",
            "worker",
          );
        try {
          await verifyConversationArtifact(checkpoint.artifact, this.host.artifacts);
        } catch (error) {
          throw new DomainError(
            "context_unavailable",
            `Saved worker conversation cannot be restored: ${errorMessage(error)}`,
            "worker",
          );
        }
      }
    }
    const inputsFrozen = Object.values(state.effects).some(
      (entry) =>
        entry.effect.kind === "launch" &&
        entry.effect.ref.worker === worker.id &&
        state.assignments[assignmentKey(entry.effect.ref)].execution.phase !== "ended",
    );
    if (command.kind === "steer" && inputsFrozen && !backend.capabilities.steer)
      throw new DomainError(
        "unsupported",
        `Backend ${worker.backend} does not support steering active work`,
        "worker",
      );
  }

  committed(transition: Transition, state: CoreState): void {
    if (transition.kind === "control_accepted" && transition.action.kind === "cancel") {
      for (const ref of transition.action.targets) {
        const active = this.active.get(assignmentKey(ref));
        if (!active) continue;
        active.controller.abort(new Error("Assignment cancellation accepted"));
        if (active.handle) this.track(this.stop(active, "cancelled").then(() => undefined));
      }
    }
    if (transition.kind === "accepted") {
      const affected = new Set(transition.messages.map((message) => assignmentKey(message.target)));
      for (const key of affected) {
        const active = this.active.get(key);
        if (active?.handle && !active.controller.signal.aborted)
          this.track(this.deliverInputs(active));
      }
    }
    if (transition.kind === "message_sent" && transition.message.to !== "coordinator") {
      const active = this.active.get(assignmentKey(transition.message.to));
      if (active?.handle && !active.controller.signal.aborted)
        this.track(this.deliverInputs(active));
    }
    if (transition.kind === "settled") {
      const parent = state.workers[transition.result.ref.worker].parentAssignment;
      const active = parent ? this.active.get(assignmentKey(parent)) : undefined;
      if (active?.handle && !active.controller.signal.aborted)
        this.track(this.deliverInputs(active));
    }
    // A replayed in-flight assignment has no live handle here. Its persisted phase
    // continues to occupy capacity until explicit backend reconciliation.
    if (hasQueuedAssignments(state)) this.wake();
  }

  wake(): void {
    if (this.pumpScheduled || this.pumping || this.closing || this.halted) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.track(this.pump());
    });
  }

  private track(operation: Promise<void>): void {
    const tracked = operation.catch((error: unknown) => {
      this.halted = true;
      this.host.diagnostic(`Execution halted with retained ownership: ${errorMessage(error)}`);
      for (const active of this.active.values()) {
        active.controller.abort(error);
        if (active.handle) void this.stop(active, "runtime failure");
      }
    });
    this.tasks.add(tracked);
    void tracked.then(() => this.tasks.delete(tracked));
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closing || this.halted) return;
    this.pumping = true;
    try {
      while (!this.closing && !this.halted) {
        const selected = await this.host.transaction(async (transaction) => {
          const state = transaction.state();
          const cancelled = queuedAssignments(state, true).find(
            (assignment) => !this.active.has(assignmentKey(assignment.ref)),
          );
          const assignment = cancelled ?? readyAssignments(state, 1)[0];
          if (!assignment) return undefined;
          const key = assignmentKey(assignment.ref);
          if (this.active.has(key)) return undefined;
          const worker = state.workers[assignment.ref.worker];
          let resolveStopped = (_receipt: StopReceipt): void => {};
          const stopped = new Promise<StopReceipt>((resolve) => {
            resolveStopped = resolve;
          });
          const active: ActiveAssignment = {
            assignment: immutable(assignment),
            worker: immutable(worker),
            attemptId: `${key}/attempt/1`,
            ownerEpoch: this.host.ownerEpoch,
            recovered: false,
            controller: new AbortController(),
            stopped,
            resolveStopped,
            sending: new Set(),
            launchInvoked: false,
          };
          this.active.set(key, active);
          if (!cancelled) {
            await transaction.commitAll([
              {
                kind: "assignment_state",
                ref: assignment.ref,
                execution: { phase: "preparing" },
              },
              {
                kind: "attempt_started",
                attempt: {
                  id: active.attemptId,
                  ref: assignment.ref,
                  ordinal: 1,
                  backend: worker.backend,
                  ownerEpoch: this.host.ownerEpoch,
                },
              },
              {
                kind: "effect_intent",
                effect: { id: `${active.attemptId}/prepare`, ref: assignment.ref, kind: "prepare" },
              },
            ]);
          }
          const inputs: SelectedInput[] = cancelled
            ? []
            : assignment.inputs.map((ref) => ({ ref, stored: state.results[assignmentKey(ref)] }));
          return { active, cancelled: Boolean(cancelled), inputs: immutable(inputs) };
        });
        if (!selected) break;
        const execution = selected.cancelled
          ? this.finishQueuedCancellation(selected.active)
          : this.run(selected.active, selected.inputs);
        this.track(
          execution.finally(() => {
            this.active.delete(assignmentKey(selected.active.assignment.ref));
            this.wake();
          }),
        );
      }
    } finally {
      this.pumping = false;
    }
  }

  async recover(targets?: AssignmentRef[]): Promise<RecoveryReceipt[]> {
    if (this.closing || this.halted)
      throw new DomainError("conflict", "Runtime execution is closing or halted");
    const selected = await this.host.transaction(async (transaction) => {
      const state = transaction.state();
      const refs = targets ?? occupiedAssignments(state).map((assignment) => assignment.ref);
      return refs.map((ref) => {
        const key = assignmentKey(ref);
        const assignment = state.assignments[key];
        if (!assignment)
          throw new DomainError("dependency_missing", "Recovery assignment does not exist");
        const entry = assignmentAttempts(state, key).at(-1);
        if (this.active.has(key))
          return { receipt: { ref, attemptId: entry?.attempt.id, status: "active" as const } };
        if (
          !entry ||
          assignment.execution.phase === "queued" ||
          (assignment.execution.phase === "ended" && assignment.execution.cleanup === "confirmed")
        )
          return {
            receipt: {
              ref,
              attemptId: entry?.attempt.id,
              status: "unavailable" as const,
              detail: "No interrupted execution requires recovery",
            },
          };
        const preparation =
          !entry.identity && !Object.hasOwn(state.effects, `${entry.attempt.id}/launch`);
        if (
          !(preparation && this.options.workspace.recover) &&
          entry.cleanup?.status !== "stopped" &&
          !this.options.backends[entry.attempt.backend]?.reattach
        )
          return {
            receipt: {
              ref,
              attemptId: entry.attempt.id,
              status: "unavailable" as const,
              detail: "Backend cannot reattach this execution; exclusion is retained",
            },
          };
        let resolveStopped = (_receipt: StopReceipt): void => {};
        const stopped = new Promise<StopReceipt>((resolve) => {
          resolveStopped = resolve;
        });
        const active: ActiveAssignment = {
          assignment: immutable(assignment),
          worker: immutable(state.workers[ref.worker]),
          attemptId: entry.attempt.id,
          ownerEpoch: entry.attempt.ownerEpoch,
          recovered: true,
          controller: new AbortController(),
          prepared: entry.prepared,
          stopped,
          resolveStopped,
          sending: new Set(),
          launchInvoked: !preparation,
        };
        if (Object.hasOwn(state.cancelled, key) || assignment.execution.phase === "ended")
          active.controller.abort(new Error("Recovering stopped or cancelled assignment"));
        this.active.set(key, active);
        return { active, entry: immutable(entry), preparation };
      });
    });
    const receipts: RecoveryReceipt[] = [];
    for (const selection of selected) {
      if (selection.receipt) {
        receipts.push(selection.receipt);
        continue;
      }
      const { active, entry, preparation } = selection;
      const ref = active.assignment.ref;
      try {
        await this.host.assertOwner();
        if (preparation && this.options.workspace.recover) {
          const recovered = await this.options.workspace.recover(
            {
              ref,
              worker: active.worker,
              ownerEpoch: active.ownerEpoch,
              artifacts: this.host.artifacts,
              prepared: entry.prepared,
            },
            new AbortController().signal,
          );
          const cleanup = cleanupReceiptSchema.parse(recovered.cleanup);
          if (cleanup.ownerEpoch !== active.ownerEpoch)
            throw new DomainError(
              "owner_unconfirmed",
              "Recovered preparation cleanup belongs to another attempt owner",
            );
          if (cleanup.status !== "stopped")
            throw new DomainError("owner_unconfirmed", cleanup.reasons.join("; "));
          if (recovered.prepared) {
            active.prepared = preparedWorkspaceSchema.parse(recovered.prepared);
            await this.record({
              kind: "workspace_recovered",
              attemptId: active.attemptId,
              prepared: active.prepared,
              evidence: recovered.artifacts,
            });
          }
          await this.recordEffectObservation(
            `${active.attemptId}/prepare`,
            "failed",
            "Interrupted preparation was reconciled without launching a worker",
          );
          const outcome = entry.outcome ?? {
            ...this.emptyOutcome(
              await this.stoppedReason(ref),
              "Workspace preparation was interrupted; retained files and helper evidence remain available",
              active.attemptId,
              true,
            ),
            artifacts: recovered.artifacts,
          };
          const execution = this.finalize(active, {
            outcome,
            cleanup,
            capture: entry.capture,
          }).finally(() => {
            this.active.delete(assignmentKey(ref));
            this.wake();
          });
          this.track(execution);
          receipts.push({ ref, attemptId: active.attemptId, status: "finalizing" });
          continue;
        }
        if (entry.cleanup?.status !== "stopped") {
          const backend = this.options.backends[entry.attempt.backend];
          if (!backend?.reattach) throw new Error("Backend reattachment is unavailable");
          active.handle = await backend.reattach(
            {
              ref,
              attemptId: active.attemptId,
              ownerEpoch: active.ownerEpoch,
              runtimeOwnerEpoch: this.host.ownerEpoch,
              identity: entry.identity,
              storeDirectory: this.host.directory,
              artifacts: this.host.artifacts,
            },
            (event, source) => this.observe(active, event, source),
            active.controller.signal,
          );
          if (
            active.handle.identity.ownerEpoch !== active.ownerEpoch ||
            active.handle.identity.kind !== active.worker.backend ||
            (entry.identity && digestValue(entry.identity) !== digestValue(active.handle.identity))
          )
            throw new DomainError(
              "capability_denied",
              "Reattached handle does not match the original attempt",
            );
          await this.recordEffectObservation(`${active.attemptId}/launch`, "completed");
        }
        const execution = this.resume(active, entry).finally(() => {
          this.active.delete(assignmentKey(ref));
          this.wake();
        });
        this.track(execution);
        receipts.push({
          ref,
          attemptId: active.attemptId,
          status: entry.cleanup?.status === "stopped" ? "finalizing" : "reattached",
        });
      } catch (cause) {
        this.active.delete(assignmentKey(ref));
        this.host.diagnostic(
          `Recovery retained exclusion for ${active.attemptId}: ${errorMessage(cause)}`,
        );
        receipts.push({
          ref,
          attemptId: active.attemptId,
          status: "uncertain",
          detail: errorMessage(cause),
        });
      }
    }
    return immutable(receipts);
  }

  private async resume(active: ActiveAssignment, entry: AttemptState): Promise<void> {
    let outcome = entry.outcome;
    let cleanup: CleanupReceipt | undefined =
      entry.cleanup?.status === "stopped" ? entry.cleanup : undefined;
    let checkpoint = outcome?.session;
    if (!outcome) {
      const handle = active.handle;
      if (!handle) throw new Error("Recovered cleanup lacks a retained outcome");
      if (active.controller.signal.aborted)
        this.track(this.stop(active, "recovered cancellation").then(() => undefined));
      else this.track(this.deliverInputs(active));
      const completed = handle.done.then(
        (value) => ({ kind: "outcome" as const, outcome: backendOutcomeSchema.parse(value) }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const completion = await Promise.race([
        completed,
        active.stopped.then((receipt) => ({ kind: "stopped" as const, receipt })),
      ]);
      if (completion.kind === "error") throw completion.error;
      if (completion.kind === "outcome") outcome = completion.outcome;
      else {
        cleanup = completion.receipt.cleanup;
        checkpoint = completion.receipt.checkpoint;
        outcome =
          completion.receipt.outcome ??
          this.emptyOutcome(
            await this.stoppedReason(active.assignment.ref),
            "Stopped before a final backend outcome was retained",
            active.attemptId,
            false,
          );
      }
      checkpoint ??= outcome.session;
    }
    await this.finalize(active, { outcome, cleanup, checkpoint, capture: entry.capture });
  }

  private async record(transition: Transition): Promise<void> {
    await this.host.transaction(async (transaction) => transaction.commit(transition));
  }

  private async run(active: ActiveAssignment, selectedInputs: SelectedInput[]): Promise<void> {
    const { ref } = active.assignment;
    let outcome: BackendOutcome | undefined;
    let cleanup: CleanupReceipt | undefined;
    let checkpoint: SessionCheckpoint | undefined;
    try {
      // Results are immutable. Capture them when selecting ready work, without
      // another queue turn before preparing its workspace. A missing result still
      // fails this assignment here rather than halting the scheduler.
      const inputs = selectedInputs.map(({ ref, stored }) => {
        if (!stored)
          throw new DomainError(
            "context_unavailable",
            `Snapshot input is unavailable: ${ref.worker}/${ref.assignment}`,
          );
        return { ref, ...stored };
      });
      await this.host.assertOwner();
      const prepared = preparedWorkspaceSchema.parse(
        await this.options.workspace.prepare(
          {
            ref,
            worker: active.worker,
            inputs,
            artifacts: this.host.artifacts,
            ownerEpoch: this.host.ownerEpoch,
          },
          active.controller.signal,
        ),
      );
      active.prepared = prepared;
      // Publish the consecutive preparation/launch records in one queue turn.
      // Deterministic preparation records share one durability barrier. Launch
      // still waits for durable inputs and its own committed intent.
      const launch = await this.host.transaction(async (transaction) => {
        await transaction.commitAll([
          {
            kind: "workspace_prepared",
            attemptId: active.attemptId,
            prepared,
          },
          {
            kind: "effect_observed",
            effectId: `${active.attemptId}/prepare`,
            status: "completed",
          },
        ]);
        if (active.controller.signal.aborted) return undefined;
        const state = transaction.state();
        const continuation = Object.hasOwn(state.sessions, active.worker.id)
          ? state.sessions[active.worker.id]
          : undefined;
        if (ref.assignment > 1 && !continuation)
          throw new DomainError(
            "context_unavailable",
            "Saved worker conversation is unavailable; restore it before continuing",
          );
        if (continuation) {
          try {
            await verifyConversationArtifact(continuation.artifact, this.host.artifacts);
          } catch (cause) {
            throw new DomainError(
              "context_unavailable",
              `Saved worker conversation cannot be restored: ${errorMessage(cause)}`,
            );
          }
        }
        const initialMessages = await this.claimInputs(active, transaction);
        const brief = {
          task: active.assignment.task,
          context: active.assignment.context,
          dependencies: dependencyResults(state, active.assignment),
        };
        const input = await this.host.artifacts.put(
          Buffer.from(
            canonicalJson({
              ref,
              attemptId: active.attemptId,
              worker: active.worker,
              cwd: active.prepared?.cwd,
              initialMessages,
              brief,
              continuation,
            }),
          ),
        );
        await transaction.commit({
          kind: "effect_intent",
          effect: { id: `${active.attemptId}/launch`, ref, kind: "launch", input },
        });
        return {
          ref,
          attemptId: active.attemptId,
          worker: active.worker,
          cwd: active.prepared?.cwd ?? "",
          initialMessages,
          brief,
          continuation,
          storeDirectory: this.host.directory,
          artifacts: this.host.artifacts,
          ownerEpoch: this.host.ownerEpoch,
        };
      });
      if (!launch) {
        cleanup = this.noActivity();
        outcome = this.emptyOutcome(
          await this.stoppedReason(ref),
          "Stopped before backend launch",
          active.attemptId,
        );
      } else {
        const backend = this.options.backends[active.worker.backend];
        if (!backend)
          throw new DomainError("unsupported", `Backend ${active.worker.backend} is unavailable`);
        await this.host.assertOwner();
        if (active.controller.signal.aborted)
          throw new PreparationFailure("Cancelled before backend launch", {
            cleanup: this.noActivity(),
            prepared: active.prepared,
            artifacts: active.prepared.artifacts,
          });
        active.launchInvoked = true;
        active.handle = await backend.start(
          launch,
          (event, source) => this.observe(active, event, source),
          active.controller.signal,
        );
        const completed = active.handle.done.then(
          (value) => {
            const parsed = backendOutcomeSchema.safeParse(value);
            return parsed.success
              ? { kind: "outcome" as const, outcome: parsed.data }
              : { kind: "error" as const, error: parsed.error };
          },
          (cause: unknown) => ({ kind: "error" as const, error: cause }),
        );
        await this.record({
          kind: "effect_observed",
          effectId: `${active.attemptId}/launch`,
          status: "completed",
        });
        await this.host.transaction(async (transaction) => {
          const current = transaction.state().assignments[assignmentKey(ref)];
          if (current.execution.phase !== "stopping")
            await transaction.commit({
              kind: "assignment_state",
              ref,
              execution: { phase: "running" },
            });
          for (const message of launch.initialMessages)
            await this.transportObservation(message, active, "transport_queued", transaction);
        });
        if (active.controller.signal.aborted)
          this.track(this.stop(active, "cancelled").then(() => undefined));
        else this.track(this.deliverInputs(active));
        const completion = await Promise.race([
          completed,
          active.stopped.then((receipt) => ({ kind: "stopped" as const, receipt })),
        ]);
        if (completion.kind === "error") throw completion.error;
        if (completion.kind === "outcome") outcome = completion.outcome;
        else {
          cleanup = completion.receipt.cleanup;
          checkpoint = completion.receipt.checkpoint;
          outcome =
            completion.receipt.outcome ??
            this.emptyOutcome(
              await this.stoppedReason(ref),
              "Stopped before a final backend outcome was retained",
              active.attemptId,
              false,
            );
        }
        if (outcome.session) checkpoint = outcome.session;
      }
    } catch (cause) {
      const error = errorMessage(cause);
      const reason = await this.stoppedReason(ref);
      if (cause instanceof PreparationFailure || cause instanceof BackendStartFailure) {
        cleanup = cleanupReceiptSchema.parse(cause.cleanup);
        if (cause instanceof PreparationFailure) {
          active.prepared = cause.prepared;
          const prepared = active.prepared;
          if (prepared)
            await this.host.transaction(async (transaction) => {
              if (!transaction.state().attempts[active.attemptId].prepared)
                await transaction.commit({
                  kind: "workspace_prepared",
                  attemptId: active.attemptId,
                  prepared,
                });
            });
        }
        outcome = {
          ...this.emptyOutcome(
            reason,
            error,
            active.attemptId,
            cleanup.status === "stopped" && !active.launchInvoked,
          ),
          artifacts: cause.artifacts,
        };
      } else {
        const knownStopped = Boolean(active.prepared && !active.launchInvoked);
        outcome = this.emptyOutcome(reason, error, active.attemptId, knownStopped);
        if (!active.handle)
          cleanup = knownStopped
            ? this.noActivity()
            : this.unknownCleanup(
                [],
                `Preparation or backend launch did not prove cleanup: ${error}`,
              );
      }
      await this.host.transaction(async (transaction) => {
        for (const stage of ["prepare", "launch"] as const) {
          const effectId = `${active.attemptId}/${stage}`;
          const effect = transaction.state().effects[effectId];
          if (effect?.status === "intent")
            await transaction.commit({
              kind: "effect_observed",
              effectId,
              status: cleanup?.status === "stopped" ? "failed" : "uncertain",
              detail: error,
            });
        }
        for (const message of Object.values(transaction.state().inbox)) {
          if (
            assignmentKey(message.target) === assignmentKey(ref) &&
            message.state === "dispatch_intent"
          )
            await this.transportObservation(message, active, "uncertain", transaction);
        }
      });
    }
    if (!outcome) throw new Error("Execution finished without an outcome observation");
    await this.finalize(active, { outcome, cleanup, checkpoint });
  }

  private stoppedReason(ref: AssignmentRef): Promise<"cancelled" | "failed"> {
    return this.host.transaction(async (transaction) =>
      Object.hasOwn(transaction.state().cancelled, assignmentKey(ref)) ? "cancelled" : "failed",
    );
  }

  private async finalize(
    active: ActiveAssignment,
    completion: {
      outcome: BackendOutcome;
      cleanup?: CleanupReceipt;
      checkpoint?: SessionCheckpoint;
      capture?: WorkspaceCapture;
    },
  ): Promise<void> {
    const { ref } = active.assignment;
    const { outcome } = completion;
    let { cleanup, checkpoint, capture } = completion;
    const finalizationErrors: string[] = [];
    let captureRequested = false;
    await this.host.transaction(async (transaction) => {
      const state = transaction.state();
      const entry = state.attempts[active.attemptId];
      // New assignments never capture the checkout. Retained intents from older
      // hosts still own their recovery work and evidence.
      captureRequested = Object.hasOwn(state.effects, `${active.attemptId}/capture`);
      if (!entry.outcome) {
        const artifact = await this.host.artifacts.put(Buffer.from(canonicalJson(outcome)));
        await transaction.commit({
          kind: "attempt_outcome",
          attemptId: active.attemptId,
          outcome,
          artifact,
        });
      }
    });
    if (checkpoint)
      await this.record({ kind: "session_checkpoint", worker: active.worker.id, checkpoint });
    if (!checkpoint && active.handle && !cleanup) {
      const effectId = `${active.attemptId}/checkpoint`;
      await this.recordEffectIntent(active, "checkpoint");
      try {
        checkpoint = sessionCheckpointSchema.parse(await active.handle.checkpoint());
        await this.record({ kind: "session_checkpoint", worker: active.worker.id, checkpoint });
        await this.recordEffectObservation(effectId, "completed");
      } catch (cause) {
        const message = `Session checkpoint failed: ${errorMessage(cause)}`;
        finalizationErrors.push(message);
        await this.recordEffectObservation(effectId, "failed", message);
      }
    }
    await this.host.transaction(async (transaction) => {
      const assignment = transaction.state().assignments[assignmentKey(ref)];
      if (assignment.execution.phase !== "ended" && assignment.execution.phase !== "finalizing")
        await transaction.commit({
          kind: "assignment_state",
          ref,
          execution: { phase: "finalizing" },
        });
    });
    if (!cleanup) {
      const stopped = active.handle
        ? await this.stop(active, active.controller.signal.aborted ? "cancelled" : outcome.reason)
        : { cleanup: this.noActivity(active.ownerEpoch) };
      cleanup = stopped.cleanup;
      if (!checkpoint && stopped.checkpoint) {
        checkpoint = stopped.checkpoint;
        await this.record({ kind: "session_checkpoint", worker: active.worker.id, checkpoint });
      }
    }
    await this.host.transaction(async (transaction) => {
      const entry = transaction.state().attempts[active.attemptId];
      if (entry.cleanup?.status !== "stopped")
        await transaction.commit({
          kind: "cleanup_observed",
          attemptId: active.attemptId,
          receipt: cleanup,
        });
    });
    if (captureRequested && cleanup.status === "stopped" && active.prepared && !capture) {
      await this.recordEffectIntent(active, "capture");
      try {
        await this.host.assertOwner();
        if (!this.options.workspace.capture)
          throw new Error("The workspace adapter cannot recover a legacy capture intent");
        // Cancellation must retain the final partial workspace too. Capture gets a
        // fresh signal because the model's cancellation has already been confirmed.
        capture = workspaceCaptureSchema.parse(
          await this.options.workspace.capture(
            {
              prepared: active.prepared,
              ref,
              cleanup,
              reason: outcome.reason,
              artifacts: this.host.artifacts,
            },
            new AbortController().signal,
          ),
        );
        await this.record({ kind: "workspace_captured", attemptId: active.attemptId, capture });
        await this.recordEffectObservation(`${active.attemptId}/capture`, "completed");
      } catch (cause) {
        const message = `Workspace capture failed: ${errorMessage(cause)}`;
        finalizationErrors.push(message);
        await this.recordEffectObservation(`${active.attemptId}/capture`, "failed", message);
      }
    }
    finalizationErrors.push(...(capture?.errors ?? []));
    await this.finish(active, {
      outcome,
      cleanup,
      checkpoint,
      capture,
      finalizationErrors,
    });
    if (cleanup.status === "stopped" && active.prepared) {
      await this.host.assertOwner();
      await this.options.workspace.release({
        ref,
        prepared: active.prepared,
        cleanup,
        artifacts: this.host.artifacts,
      });
    }
  }

  private async recordEffectIntent(
    active: ActiveAssignment,
    kind: "checkpoint" | "capture" | "cleanup",
  ): Promise<void> {
    await this.host.transaction(async (transaction) => {
      const id = `${active.attemptId}/${kind}`;
      if (!Object.hasOwn(transaction.state().effects, id))
        await transaction.commit({
          kind: "effect_intent",
          effect: { id, ref: active.assignment.ref, kind },
        });
    });
  }

  private async recordEffectObservation(
    effectId: string,
    status: "completed" | "failed" | "uncertain",
    detail?: string,
  ): Promise<void> {
    await this.host.transaction(async (transaction) => {
      const effect = transaction.state().effects[effectId];
      if (effect && (effect.status === "intent" || effect.status === "uncertain"))
        await transaction.commit({
          kind: "effect_observed",
          effectId,
          status,
          ...(detail ? { detail } : {}),
        });
    });
  }

  private async finish(
    active: ActiveAssignment,
    completion: {
      outcome: BackendOutcome;
      cleanup: CleanupReceipt;
      checkpoint?: SessionCheckpoint;
      capture?: WorkspaceCapture;
      finalizationErrors: string[];
    },
  ): Promise<void> {
    await this.host.transaction(async (transaction) => {
      const state = transaction.state();
      const ref = active.assignment.ref;
      // A recovery may prove cleanup after an interrupted result was already delivered.
      // Preserve that immutable result and its stable completion notification.
      const key = assignmentKey(ref);
      if (Object.hasOwn(state.results, key)) return;
      const failedFinalization = assignmentEffects(state, key)
        .filter(
          (entry) =>
            (entry.effect.kind === "checkpoint" || entry.effect.kind === "capture") &&
            entry.status === "failed",
        )
        .map((entry) => entry.detail ?? `${entry.effect.kind} failed`);
      const finalizationErrors = [
        ...new Set([...completion.finalizationErrors, ...failedFinalization]),
      ];
      const cancelled = Object.hasOwn(state.cancelled, key);
      const reason =
        completion.cleanup.status === "unconfirmed"
          ? "interrupted"
          : cancelled
            ? "cancelled"
            : failedFinalization.length
              ? "failed"
              : completion.outcome.reason;
      const result: AssignmentResult = {
        ref,
        summary: completion.outcome.summary,
        ...(finalizationErrors.length ? { finalizationErrors } : {}),
        execution: {
          phase: "ended",
          reason,
          cleanup: completion.cleanup.status === "stopped" ? "confirmed" : "unconfirmed",
        },
        artifacts: uniqueArtifacts([
          ...(active.prepared?.artifacts ?? []),
          ...completion.outcome.artifacts,
          ...(completion.capture?.artifacts ?? []),
          ...completion.cleanup.evidence,
          ...(completion.capture?.snapshot ? [completion.capture.snapshot] : []),
        ]),
        usage: assignmentUsage(state, ref),
        ...(completion.outcome.report ? { report: completion.outcome.report } : {}),
        ...(completion.outcome.reportingError
          ? { reportingError: completion.outcome.reportingError }
          : {}),
        ...(completion.outcome.transcript ? { transcript: completion.outcome.transcript } : {}),
        ...(completion.checkpoint ? { session: completion.checkpoint.artifact } : {}),
        ...(completion.capture?.snapshot ? { snapshot: completion.capture.snapshot } : {}),
        ...(active.prepared?.worktree ? { worktree: active.prepared.worktree } : {}),
      };
      const resultArtifact = await this.host.artifacts.put(Buffer.from(canonicalJson(result)));
      await transaction.commit({
        kind: "settled",
        result,
        resultArtifact,
        notificationId: `${ref.run}/${ref.worker}/${ref.assignment}/completed`,
      });
    });
  }

  private async finishQueuedCancellation(active: ActiveAssignment): Promise<void> {
    await this.host.transaction(async (transaction) => {
      const ref = active.assignment.ref;
      const result: AssignmentResult = {
        ref,
        summary: "Cancelled before execution",
        execution: { phase: "ended", reason: "cancelled", cleanup: "confirmed" },
        artifacts: [],
        usage: assignmentUsage(transaction.state(), ref),
      };
      const resultArtifact = await this.host.artifacts.put(Buffer.from(canonicalJson(result)));
      await transaction.commit({
        kind: "settled",
        result,
        resultArtifact,
        notificationId: `${ref.run}/${ref.worker}/${ref.assignment}/completed`,
      });
    });
  }

  private async claimInputs(
    active: ActiveAssignment,
    transaction: ExecutionTransaction,
  ): Promise<InboxMessage[]> {
    const messages = Object.values(transaction.state().inbox).filter(
      (message) =>
        assignmentKey(message.target) === assignmentKey(active.assignment.ref) &&
        message.state === "recorded" &&
        !active.sending.has(message.id),
    );
    await transaction.commitAll(
      messages.map((message) => ({
        kind: "inbox_state",
        messageId: message.id,
        state: "dispatch_intent",
        attemptId: `${active.attemptId}/input/${message.id}`,
      })),
    );
    for (const message of messages) active.sending.add(message.id);
    return immutable(messages);
  }

  private async deliverInputs(active: ActiveAssignment): Promise<void> {
    if (!active.handle || active.controller.signal.aborted) return;
    const messages = await this.host.transaction((transaction) =>
      this.claimInputs(active, transaction),
    );
    for (const message of messages) {
      let state: "transport_queued" | "transport_handled" | "uncertain" = "uncertain";
      try {
        await this.host.assertOwner();
        const transport = transportReceiptSchema.parse(await active.handle.input(message));
        if (transport.status === "undelivered") {
          const receipt = await this.host.artifacts.put(Buffer.from(canonicalJson(transport)));
          await this.record({
            kind: "inbox_not_delivered",
            messageId: message.id,
            attemptId: `${active.attemptId}/input/${message.id}`,
            receipt,
          });
          active.sending.delete(message.id);
          continue;
        }
        state = transport.status;
      } catch (error) {
        this.host.diagnostic(`Input ${message.id} transport is uncertain: ${errorMessage(error)}`);
      }
      await this.host.transaction((transaction) =>
        this.transportObservation(message, active, state, transaction),
      );
    }
  }

  private async transportObservation(
    message: InboxMessage,
    active: ActiveAssignment,
    state: "transport_queued" | "transport_handled" | "uncertain",
    transaction: ExecutionTransaction,
  ): Promise<void> {
    const current = transaction.state().inbox[message.id];
    if (current.state === "consumed") return;
    await transaction.commit({
      kind: "inbox_state",
      messageId: message.id,
      state,
      attemptId: `${active.attemptId}/input/${message.id}`,
    });
  }

  private async observe(
    active: ActiveAssignment,
    input: BackendObservation,
    sourceInput?: ObservationSource,
  ): Promise<void> {
    const observation = backendObservationSchema.parse(input);
    const source = sourceInput ? backendObservationSourceSchema.parse(sourceInput) : undefined;
    if (active.recovered && observation.kind !== "activity" && !source)
      throw new DomainError(
        "invalid_input",
        "Recovered backend observations require stable source identities",
      );
    if (observation.kind === "activity") {
      this.host.activity(active.assignment.ref, observation);
      return;
    }
    await this.host.transaction(async (transaction) => {
      const state = transaction.state();
      const identity = source
        ? {
            requestId: `backend/${JSON.stringify([active.attemptId, source.sourceId, source.ordinal])}`,
            payloadDigest: digestValue({ source, observation }),
          }
        : undefined;
      const commit = (transition: Transition): Promise<void> =>
        transaction.commit(transition, identity);
      switch (observation.kind) {
        case "enrolled":
          if (
            observation.identity.ownerEpoch !== active.ownerEpoch ||
            observation.identity.kind !== active.worker.backend
          )
            throw new DomainError(
              "capability_denied",
              "Backend enrollment does not match this attempt",
            );
          await commit({
            kind: "backend_enrolled",
            attemptId: active.attemptId,
            identity: observation.identity,
            evidence: observation.evidence,
          });
          return;
        case "input_consumed": {
          const message = Object.hasOwn(state.inbox, observation.messageId)
            ? state.inbox[observation.messageId]
            : undefined;
          if (!message || assignmentKey(message.target) !== assignmentKey(active.assignment.ref))
            throw new DomainError(
              "capability_denied",
              "Backend consumption references another assignment",
            );
          if (message.state === "consumed" && !source) return;
          await commit({
            kind: "inbox_state",
            messageId: message.id,
            state: "consumed",
            attemptId: `${active.attemptId}/input/${message.id}`,
            checkpoint: observation.checkpoint,
          });
          return;
        }
        case "usage":
          if (observation.attemptId !== active.attemptId)
            throw new DomainError("capability_denied", "Usage belongs to another attempt");
          await commit({
            kind: "usage_observed",
            attemptId: active.attemptId,
            observation: observation.observation,
          });
          return;
        case "response":
          if (observation.attemptId !== active.attemptId)
            throw new DomainError("capability_denied", "Response belongs to another attempt");
          await commit({
            kind: "response_observed",
            attemptId: active.attemptId,
            responseId: observation.responseId,
            status: observation.status,
          });
          return;
        case "context":
          if (observation.attemptId !== active.attemptId)
            throw new DomainError(
              "capability_denied",
              "Context observation belongs to another attempt",
            );
          await commit({
            kind: "context_observed",
            attemptId: active.attemptId,
            context: observation.context,
          });
          return;
      }
    });
  }

  private stop(active: ActiveAssignment, reason: string): Promise<StopReceipt> {
    if (active.stop) return active.stop;
    const handle = active.handle;
    if (!handle)
      return Promise.resolve({ cleanup: this.unknownCleanup([], "Backend handle is unavailable") });
    active.stop = (async () => {
      let intentCommitted = false;
      try {
        await this.host.transaction(async (transaction) => {
          const assignment = transaction.state().assignments[assignmentKey(active.assignment.ref)];
          if (
            active.controller.signal.aborted &&
            assignment.execution.phase !== "ended" &&
            assignment.execution.phase !== "stopping"
          )
            await transaction.commit({
              kind: "assignment_state",
              ref: active.assignment.ref,
              execution: { phase: "stopping" },
            });
          const id = `${active.attemptId}/cleanup`;
          if (!Object.hasOwn(transaction.state().effects, id))
            await transaction.commit({
              kind: "effect_intent",
              effect: { id, ref: active.assignment.ref, kind: "cleanup" },
            });
        });
        intentCommitted = true;
      } catch (error) {
        this.host.diagnostic(`Cleanup intent could not be committed: ${errorMessage(error)}`);
      }
      let receipt: StopReceipt;
      try {
        const stopped = await handle.stop(reason);
        const cleanup = cleanupReceiptSchema.parse(stopped.cleanup);
        if (
          cleanup.ownerEpoch !== active.ownerEpoch ||
          !cleanup.identities.includes(handle.identity.id)
        )
          receipt = {
            cleanup: this.unknownCleanup(
              [handle.identity.id],
              "Cleanup receipt does not cover the owned backend identity",
              active.ownerEpoch,
            ),
          };
        else
          receipt = {
            cleanup,
            ...(stopped.outcome ? { outcome: backendOutcomeSchema.parse(stopped.outcome) } : {}),
            ...(stopped.checkpoint
              ? { checkpoint: sessionCheckpointSchema.parse(stopped.checkpoint) }
              : {}),
          };
      } catch (error) {
        receipt = {
          cleanup: this.unknownCleanup(
            [handle.identity.id],
            errorMessage(error),
            active.ownerEpoch,
          ),
        };
      }
      if (intentCommitted) {
        try {
          await this.recordEffectObservation(
            `${active.attemptId}/cleanup`,
            receipt.cleanup.status === "stopped" ? "completed" : "uncertain",
            receipt.cleanup.status === "unconfirmed"
              ? receipt.cleanup.reasons.join("; ")
              : undefined,
          );
        } catch (error) {
          this.host.diagnostic(
            `Cleanup observation could not be committed: ${errorMessage(error)}`,
          );
        }
      }
      active.resolveStopped(receipt);
      return receipt;
    })();
    return active.stop;
  }

  private noActivity(ownerEpoch = this.host.ownerEpoch): CleanupReceipt {
    return { status: "stopped", ownerEpoch, identities: [], evidence: [] };
  }

  private unknownCleanup(
    identities: string[],
    reason: string,
    ownerEpoch = this.host.ownerEpoch,
  ): CleanupReceipt {
    return {
      status: "unconfirmed",
      ownerEpoch,
      identities,
      reasons: [reason],
      evidence: [],
    };
  }

  private emptyOutcome(
    reason: BackendOutcome["reason"],
    summary: string,
    attemptId: string,
    knownZero = true,
  ): BackendOutcome {
    return {
      reason,
      summary,
      artifacts: [],
      usage: {
        expectedAttempts: [attemptId],
        observations: knownZero
          ? [
              {
                attempt: attemptId,
                source: `${attemptId}/known-zero`,
                kind: "attempt_total",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
              },
            ]
          : [],
        complete: knownZero,
        ...(knownZero
          ? {}
          : { reason: "Backend accounting is unavailable after interrupted execution" }),
      },
    };
  }

  async close(reason: string): Promise<boolean> {
    this.closing = true;
    for (const active of this.active.values()) {
      active.controller.abort(new Error(reason));
      if (active.handle) this.track(this.stop(active, reason).then(() => undefined));
    }
    while (this.tasks.size) await Promise.all(this.tasks);
    return this.host.transaction(async (transaction) => {
      const state = transaction.state();
      return !this.halted && occupiedCount(state) === 0;
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueArtifacts(artifacts: ArtifactRef[]): ArtifactRef[] {
  return [
    ...new Map(
      artifacts.map((artifact) => [`${artifact.digest}/${artifact.size}`, artifact]),
    ).values(),
  ];
}
