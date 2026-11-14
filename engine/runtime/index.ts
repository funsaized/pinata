import type { LaunchInfo } from "../contracts/runtime.ts";
import { Schedules, type SchedulingOptions } from "../schedules/index.ts";
import { randomUUID } from "node:crypto";
import type { BackendObservation, SessionCheckpoint } from "../contracts/backend.ts";
import {
  assignmentKey,
  DomainError,
  type ArtifactRef,
  type AssignmentRef,
  type CallerAuthority,
  type CommandError,
} from "../contracts/common.ts";
import {
  commandEnvelopeSchema,
  type CommandEnvelope,
  type FrozenWorker,
  type WorkerRequest,
} from "../contracts/commands.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import { configSchema, type Config, type ConfigLayer } from "../contracts/config.ts";
import {
  transitionSchema,
  transitionArtifacts,
  type CommandReceipt,
  type Effect,
  type Transition,
} from "../contracts/lifecycle.ts";
import {
  runtimeQuerySchema,
  recoveryRequestSchema,
  type RecoveryReceipt,
  queryResultSchema,
  subscriptionSchema,
  waitRequestSchema,
  type QueryResult,
  type RuntimeEvent,
  type ShutdownReceipt,
  type ShutdownRequest,
  type WaitResult,
} from "../contracts/runtime.ts";
import { exportSchemas } from "../contracts/schemas.ts";
import type { JournalFrame, Manifest } from "../contracts/storage.ts";
import type { DefinitionSummary } from "../contracts/definition.ts";
import { prepareCommand } from "../core/accept.ts";
import { prepareControl } from "../core/control.ts";
import { initialState, reduce } from "../core/state.ts";
import { DurableStore } from "../storage/index.ts";
import { StorageError, type FaultHook } from "../storage/io.ts";
import { RuntimeApplications, type RuntimeApplicationPort } from "./application.ts";
import { readChanges } from "./changes.ts";
import { ChildBindings } from "./delegation.ts";
import { messageReceipt, messageTarget, queryMessages, validateMessage } from "../core/messages.ts";
import {
  workerMessageRequestSchema,
  type MessagePort,
  type WorkerMessage,
} from "../contracts/messages.ts";
import type { ChildPort } from "../contracts/delegation.ts";
import { checkChildCaller, checkChildCommand } from "../core/delegation.ts";
import { immutable } from "./immutable.ts";
import { ConversationQueries, savedConversation } from "./queries.ts";
import {
  ExecutionCoordinator,
  type ExecutionOptions,
  type ExecutionTransaction,
} from "./execution.ts";
import {
  CompletionDelivery,
  type NotificationDelivery,
  type NotificationPort,
} from "./delivery.ts";

export type { ExecutionOptions } from "./execution.ts";
export type { RuntimeApplicationPort } from "./application.ts";
export type {
  CompletionNotice,
  NotificationNotice,
  NotificationDelivery,
  NotificationPort,
} from "./delivery.ts";

export type WorkerResolver = (
  requests: readonly WorkerRequest[],
  caller: CallerAuthority,
  artifacts: { putArtifact(bytes: Uint8Array): Promise<ArtifactRef> },
  context?: { config?: Config; parentCheckpoint?: SessionCheckpoint },
) => Promise<FrozenWorker[]>;

export type EffectObservation = {
  status: "completed" | "failed" | "uncertain";
  detail?: string;
};

// An inert port records effect observations without launching a worker. Execution
// adapters use the backend and workspace contracts instead.
export type InertEffectPort = {
  dispatch(effect: Effect): Promise<EffectObservation>;
};

export type RuntimeDiagnostic = { kind: "subscriber_failed" | "execution_failed"; message: string };
export type { QueryResult } from "../contracts/runtime.ts";

type Subscriber = { active: boolean; consume: (event: RuntimeEvent) => void | Promise<void> };

export type RuntimeOptions = {
  directory: string;
  manifest?: Manifest;
  fault?: FaultHook;
  resolveWorkers?: WorkerResolver;
  resolveConfig?: (config?: ConfigLayer) => Config | Promise<Config>;
  launchInfo?: (caller: CallerAuthority, config?: Config) => LaunchInfo;
  discoverDefinitions?: () => Promise<DefinitionSummary[]>;
  effectPort?: InertEffectPort;
  execution?: ExecutionOptions;
  application?: RuntimeApplicationPort;
  scheduling?: SchedulingOptions;
  notifications?: NotificationPort;
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
};

export class Runtime {
  private readonly store: DurableStore;
  private readonly options: RuntimeOptions;
  private state: ReturnType<typeof initialState>;
  private pending: Promise<void> = Promise.resolve();
  private closing = false;
  private checkpointAttemptRevision = 0;
  private readonly subscribers = new Set<Subscriber>();
  private readonly failures: RuntimeDiagnostic[] = [];
  private readonly execution?: ExecutionCoordinator;
  private readonly applications?: RuntimeApplications;
  private readonly schedules?: Schedules;
  private readonly delivery?: CompletionDelivery;
  private readonly children: ChildBindings;
  private readonly conversations: ConversationQueries;
  private shutdown?: Promise<ShutdownReceipt>;
  private readonly waitCancellations = new Set<() => void>();
  private readonly committedRequests = new Map<
    string,
    { payloadDigest: string; transitionDigest: string }
  >();

  private constructor(store: DurableStore, options: RuntimeOptions) {
    this.store = store;
    this.options = options;
    this.children = new ChildBindings(this, () =>
      this.serialize(async () => immutable(this.state)),
    );
    let state = store.replayState ?? initialState(store.manifest.run);
    this.checkpointAttemptRevision = state.revision;
    for (const frame of store.frames) {
      if (frame.record.revision > state.revision)
        state = reduce(state, frame.record.transition, frame.record.revision);
      this.committedRequests.set(frame.record.requestId, {
        payloadDigest: frame.record.payloadDigest,
        transitionDigest: digestValue(frame.record.transition),
      });
    }
    this.state = state;
    const transaction = <T>(
      operation: (transaction: ExecutionTransaction) => Promise<T>,
    ): Promise<T> =>
      this.serialize(() =>
        operation({
          state: () => this.state,
          commitAll: (transitions) =>
            this.commitBatch(
              transitions.map((transition) => ({
                requestId: randomUUID(),
                payloadDigest: digestValue(transition),
                transition,
              })),
            ),
          commit: async (transition, identity) =>
            this.commit({
              requestId: identity?.requestId ?? randomUUID(),
              payloadDigest: identity?.payloadDigest ?? digestValue(transition),
              transition,
            }),
        }),
      );
    const artifacts = {
      put: (bytes: Uint8Array) => store.putArtifact(bytes),
      read: (artifact: ArtifactRef) => store.readArtifact(artifact),
    };
    this.conversations = new ConversationQueries(artifacts);
    if (options.scheduling)
      this.schedules = new Schedules(
        {
          transaction: (work) =>
            transaction(async (entry) =>
              work(entry.state(), async (transition) => {
                await entry.commit(
                  transition,
                  "requestId" in transition
                    ? { requestId: transition.requestId, payloadDigest: transition.payloadDigest }
                    : undefined,
                );
              }),
            ),
          freeze: async (request, caller) => {
            const prepared = await this.prepare(
              { requestId: randomUUID(), command: { kind: "add", workers: [request] } },
              caller,
            );
            if (prepared.kind !== "accepted" || prepared.workers.length !== 1)
              throw new DomainError("conflict", "Schedule template did not resolve one worker");
            return prepared.workers[0];
          },
          validate: async (command, state) => this.execution?.validateCommand(command, state),
          diagnostic: (message) => this.diagnostic({ kind: "execution_failed", message }),
        },
        options.scheduling,
      );
    if (options.application)
      this.applications = new RuntimeApplications(
        {
          ownerEpoch: store.owner.epoch,
          artifacts,
          transaction,
          assertOwner: () => store.assertOwner(),
        },
        options.application,
      );
    if (options.notifications)
      this.delivery = new CompletionDelivery(
        { transaction, artifacts, assertOwner: () => store.assertOwner() },
        options.notifications,
      );
    if (options.execution) {
      this.execution = new ExecutionCoordinator(
        {
          directory: store.directory,
          ownerEpoch: store.owner.epoch,
          artifacts,
          transaction,
          assertOwner: () => store.assertOwner(),
          activity: (ref, observation) => this.publishActivity(ref, observation),
          diagnostic: (message) => this.diagnostic({ kind: "execution_failed", message }),
        },
        options.execution,
      );
    }
  }

  static async open(options: RuntimeOptions): Promise<Runtime> {
    const store = await DurableStore.open(options);
    try {
      const runtime = new Runtime(store, options);
      await runtime.schedules?.open();
      runtime.execution?.wake();
      return runtime;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.pending.then(operation);
    // A failed command is returned to its caller; subsequent commands still get a
    // turn so the caller can inspect the run or perform explicit reconciliation.
    this.pending = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async execute(input: unknown, caller: CallerAuthority): Promise<CommandReceipt> {
    const parsed = commandEnvelopeSchema.safeParse(input);
    if (!parsed.success) {
      const requestId = requestIdentity(input);
      const issue = parsed.error.issues[0];
      return immutable({
        status: "rejected",
        requestId,
        revision: this.state.revision,
        error: {
          code: "invalid_input",
          message: issue?.message ?? "Invalid command envelope",
          ...(issue?.path.length ? { field: issue.path.join(".") } : {}),
        },
      });
    }
    const request = parsed.data;
    if (this.closing)
      return this.rejection(
        request.requestId,
        new DomainError("conflict", "Runtime is closing; reopen it before issuing commands"),
      );
    let parentCheckpoint: SessionCheckpoint | undefined;
    if (caller.kind === "worker") {
      try {
        this.authorize(caller, true);
        checkChildCommand(this.state, caller, request.command);
        if (
          request.command.kind === "add" &&
          caller.grants.inheritContext &&
          caller.parentAssignment
        )
          parentCheckpoint = await this.parentCheckpoint(caller.parentAssignment, caller);
      } catch (error) {
        return this.rejection(request.requestId, error);
      }
    }
    if (
      request.command.kind === "apply" ||
      request.command.kind === "rollback" ||
      request.command.kind === "reconcile"
    ) {
      try {
        this.authorize(caller, true);
        if (!this.applications)
          throw new DomainError("unsupported", "No application port is configured");
        return await this.applications.execute({ ...request, command: request.command }, caller);
      } catch (error) {
        return this.rejection(request.requestId, error);
      }
    }
    return this.serialize(async () => {
      try {
        this.authorize(caller, true);
        await this.store.assertOwner();
        const payloadDigest = digestValue(request);
        const previous = Object.hasOwn(this.state.receipts, request.requestId)
          ? this.state.receipts[request.requestId]
          : undefined;
        if (previous) {
          if (previous.payloadDigest !== payloadDigest)
            throw new DomainError(
              "conflict",
              "Request ID already has a different accepted payload",
              "requestId",
            );
          return immutable(previous.receipt);
        }
        await this.execution?.validateCommand(request.command, this.state);
        const prepared = await this.prepare(request, caller, parentCheckpoint);
        await this.commit({
          requestId: request.requestId,
          payloadDigest,
          transition: prepared,
        });
        return immutable(prepared.receipt);
      } catch (error) {
        return this.rejection(request.requestId, error);
      }
    });
  }

  private async prepare(
    request: CommandEnvelope,
    caller: CallerAuthority,
    parentCheckpoint?: SessionCheckpoint,
  ) {
    const command = request.command;
    if (command.kind === "schedule") {
      if (!this.schedules)
        throw new DomainError("unsupported", "No session-owned schedule service is configured");
      return this.schedules.prepare(this.state, request, caller);
    }
    if (command.kind === "cancel" || command.kind === "background" || command.kind === "capacity")
      return prepareControl(this.state, request, caller);
    if (command.kind !== "create" && command.kind !== "add")
      return prepareCommand(this.state, request, caller);
    const resolveWorkers = this.options.resolveWorkers;
    if (!resolveWorkers)
      throw new DomainError(
        "unsupported",
        "No worker definition resolver is configured",
        "command.workers",
      );
    const acceptedConfig = this.state.config
      ? configSchema.parse(
          JSON.parse(
            Buffer.from(await this.store.readArtifact(this.state.config)).toString("utf8"),
          ),
        )
      : undefined;
    const resolvedConfig =
      command.kind === "create"
        ? this.options.resolveConfig
          ? configSchema.parse(await this.options.resolveConfig(command.config))
          : command.config
            ? configSchema.parse(command.config)
            : undefined
        : acceptedConfig;
    const workers = await resolveWorkers(
      immutable(command.workers),
      immutable(caller),
      {
        putArtifact: (bytes) => this.store.putArtifact(bytes),
      },
      immutable({ config: resolvedConfig, ...(parentCheckpoint ? { parentCheckpoint } : {}) }),
    );
    if (caller.kind === "worker" && caller.parentAssignment) {
      const parent = this.state.workers[caller.parentAssignment.worker];
      for (const worker of workers) {
        worker.parentAssignment = structuredClone(caller.parentAssignment);
        worker.depth = parent.depth + 1;
      }
    }
    this.execution?.validateWorkers(workers);
    const config =
      command.kind === "create" && resolvedConfig
        ? await this.store.putArtifact(Buffer.from(canonicalJson(resolvedConfig)))
        : undefined;
    return prepareCommand(this.state, request, caller, { workers, config, resolvedConfig });
  }

  async scheduleTick(): Promise<void> {
    await this.schedules?.tick();
  }

  bindChild(parentAssignment: AssignmentRef): ChildPort {
    return this.children.bind(parentAssignment);
  }

  bindMessages(sender: AssignmentRef): MessagePort {
    const from = immutable(sender);
    return {
      send: async (input, signal) => {
        signal?.throwIfAborted();
        const request = workerMessageRequestSchema.parse(input);
        const id = `worker-message:${digestValue([from, request.messageId])}`;
        const requestDigest = digestValue(request);
        return this.serialize(async () => {
          signal?.throwIfAborted();
          if (this.closing) throw new DomainError("conflict", "Runtime is closing");
          await this.store.assertOwner();
          const previous = this.state.messages[id];
          if (previous) {
            if (previous.requestDigest !== requestDigest)
              throw new DomainError(
                "conflict",
                "Message ID already has different content",
                "messageId",
              );
            return immutable(messageReceipt(previous));
          }
          const message: WorkerMessage = {
            id,
            from,
            to: messageTarget(this.state, from, request.to),
            text: request.text,
            requestDigest,
            revision: this.state.revision + 1,
          };
          validateMessage(this.state, message);
          if (message.to !== "coordinator" && this.options.execution) {
            const target = this.state.assignments[assignmentKey(message.to)];
            const worker = this.state.workers[message.to.worker];
            const backend = this.options.execution.backends[worker.backend];
            if (target.execution.phase !== "queued" && !backend?.capabilities.steer)
              throw new DomainError(
                "unsupported",
                `Backend ${worker.backend} cannot receive live messages`,
              );
          }
          await this.commit({
            requestId: id,
            payloadDigest: requestDigest,
            transition: { kind: "message_sent", message },
          });
          return immutable(messageReceipt(message));
        });
      },
    };
  }

  async parentCheckpoint(
    ref: AssignmentRef,
    caller: CallerAuthority,
  ): Promise<SessionCheckpoint | undefined> {
    await this.serialize(async () => {
      this.authorize(caller, false);
      if (
        caller.kind === "worker" &&
        (!caller.parentAssignment || assignmentKey(caller.parentAssignment) !== assignmentKey(ref))
      )
        throw new DomainError(
          "capability_denied",
          "A worker can snapshot only its bound parent assignment",
        );
      if (ref.run !== this.state.run || !Object.hasOwn(this.state.assignments, assignmentKey(ref)))
        throw new DomainError("invalid_input", "Unknown parent assignment");
    });
    return this.execution?.checkpoint(ref);
  }

  private authorize(caller: CallerAuthority, mutation: boolean): void {
    if (caller.run !== this.store.manifest.run)
      throw new DomainError("capability_denied", "Caller authority does not cover this run");
    if (caller.kind === "worker") checkChildCaller(this.state, caller);
    if (mutation && caller.kind === "viewer")
      throw new DomainError(
        "capability_denied",
        "Only a coordinator can mutate the acceptance runtime",
      );
  }

  private rejection(requestId: string, error: unknown): CommandReceipt {
    let detail: CommandError;
    if (error instanceof DomainError) detail = error.toJSON();
    else if (error instanceof StorageError) detail = { code: error.code, message: error.message };
    else throw error;
    return immutable({
      status: "rejected",
      requestId,
      revision: this.state.revision,
      error: detail,
    });
  }

  private async commit(input: {
    requestId: string;
    payloadDigest: string;
    transition: Transition;
    artifacts?: ArtifactRef[];
  }): Promise<void> {
    await this.commitBatch([input]);
  }

  private async commitBatch(
    inputs: readonly {
      requestId: string;
      payloadDigest: string;
      transition: Transition;
      artifacts?: ArtifactRef[];
    }[],
  ): Promise<void> {
    let next = this.state;
    const staged = new Map<
      string,
      {
        input: {
          requestId: string;
          payloadDigest: string;
          transition: Transition;
          artifacts: ArtifactRef[];
        };
        state: ReturnType<typeof initialState>;
        transitionDigest: string;
      }
    >();
    for (const input of inputs) {
      const transition = transitionSchema.parse(input.transition);
      const transitionDigest = digestValue(transition);
      const pending = staged.get(input.requestId);
      const previous = pending
        ? { payloadDigest: pending.input.payloadDigest, transitionDigest: pending.transitionDigest }
        : this.committedRequests.get(input.requestId);
      if (previous) {
        if (
          previous.payloadDigest !== input.payloadDigest ||
          previous.transitionDigest !== transitionDigest
        )
          throw new DomainError(
            "conflict",
            "A committed source identity was reused with different content",
          );
        continue;
      }
      next = reduce(next, transition, next.revision + 1);
      const artifacts = [
        ...new Map(
          [...(input.artifacts ?? []), ...transitionArtifacts(transition)].map((artifact) => [
            `${artifact.digest}/${artifact.size}`,
            artifact,
          ]),
        ).values(),
      ];
      staged.set(input.requestId, {
        input: { ...input, transition, artifacts },
        state: next,
        transitionDigest,
      });
    }
    if (!staged.size) {
      await this.store.assertOwner();
      return;
    }
    // Stage only deterministic transitions. No state, receipt, subscriber event
    // or execution effect becomes visible until the complete sync barrier passes.
    const entries = [...staged.values()];
    const frames = await this.store.appendBatch(entries.map((entry) => entry.input));
    for (const [index, entry] of entries.entries()) {
      this.state = entry.state;
      this.committedRequests.set(entry.input.requestId, {
        payloadDigest: entry.input.payloadDigest,
        transitionDigest: entry.transitionDigest,
      });
      const event = this.event(frames[index]);
      const subscribers = [...this.subscribers];
      for (const subscriber of subscribers) this.deliver(subscriber, event);
      this.execution?.committed(entry.input.transition, this.state);
      this.schedules?.changed(this.state);
    }
    await this.checkpoint();
  }

  private async checkpoint(force = false): Promise<void> {
    if (!force && this.state.revision - this.checkpointAttemptRevision < 256) return;
    this.checkpointAttemptRevision = this.state.revision;
    try {
      await this.store.checkpoint(this.state);
    } catch (error) {
      this.diagnostic({
        kind: "execution_failed",
        message: `Checkpoint projection was not saved; the journal remains authoritative: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async query(input: unknown, caller: CallerAuthority): Promise<QueryResult> {
    const request = runtimeQuerySchema.parse(input);
    if (request.kind === "wait")
      return { kind: "wait", wait: await this.wait(request.wait, caller) };
    if (request.kind === "config") {
      const artifact = await this.serialize(async () => {
        this.authorize(caller, false);
        return this.state.config;
      });
      return immutable({
        kind: "config",
        config: artifact
          ? configSchema.parse(
              JSON.parse(Buffer.from(await this.store.readArtifact(artifact)).toString("utf8")),
            )
          : null,
      });
    }
    if (request.kind === "changes") {
      const snapshot = await this.serialize(async () => {
        this.authorize(caller, false);
        if (
          request.ref.run !== this.state.run ||
          !Object.hasOwn(this.state.assignments, assignmentKey(request.ref))
        )
          throw new DomainError("invalid_input", "Unknown changes assignment", "ref");
        return this.state.results[assignmentKey(request.ref)]?.result.snapshot;
      });
      return immutable(
        await readChanges(request.ref, snapshot, { read: (ref) => this.store.readArtifact(ref) }),
      );
    }
    if (request.kind === "conversation") {
      const saved = await this.serialize(async () => {
        this.authorize(caller, false);
        return savedConversation(this.state, request.ref);
      });
      if (request.cursor || saved) return immutable(await this.conversations.query(request, saved));
      // Backend checkpointing may flush observations through the runtime queue.
      // Keep that wait outside serialization so queries cannot deadlock control.
      const checkpoint = await this.execution?.checkpoint(request.ref);
      const snapshot = checkpoint
        ? { source: "checkpoint" as const, artifact: checkpoint.artifact }
        : await this.serialize(async () => savedConversation(this.state, request.ref));
      return immutable(await this.conversations.query(request, snapshot));
    }
    return this.serialize(async () => {
      this.authorize(caller, false);
      switch (request.kind) {
        case "status":
          return immutable({ kind: "status", state: this.state });
        case "messages":
          return immutable(queryMessages(this.state, request));
        case "application":
          return immutable({
            kind: "application",
            operation: Object.hasOwn(this.state.applications, request.operationId)
              ? this.state.applications[request.operationId]
              : null,
          });
        case "receipt": {
          const stored = Object.hasOwn(this.state.receipts, request.requestId)
            ? this.state.receipts[request.requestId]
            : undefined;
          return immutable({ kind: "receipt", receipt: stored?.receipt ?? null });
        }
        case "result": {
          const stored = this.state.results[assignmentKey(request.ref)];
          return immutable({
            kind: "result",
            result: stored?.result ?? null,
            ...(stored ? { artifact: stored.artifact } : {}),
          });
        }
        case "events":
          return immutable({
            kind: "events",
            events: this.store.frames
              .filter((frame) => frame.record.revision > request.since)
              .map((frame) => this.event(frame)),
            cursor: this.state.revision,
          });
        case "schemas": {
          const schemas = exportSchemas(request.name);
          return immutable(
            queryResultSchema.parse({
              kind: "schemas",
              schemas,
            }),
          );
        }
        case "definitions": {
          const config = this.state.config
            ? configSchema.parse(
                JSON.parse(
                  Buffer.from(await this.store.readArtifact(this.state.config)).toString("utf8"),
                ),
              )
            : undefined;
          return immutable(
            queryResultSchema.parse({
              kind: "definitions",
              definitions: (await this.options.discoverDefinitions?.()) ?? [],
              ...(this.options.launchInfo
                ? { launch: this.options.launchInfo(caller, config) }
                : {}),
            }),
          );
        }
        default:
          throw new DomainError("unsupported", "Unsupported runtime query");
      }
    });
  }

  async wait(input: unknown, caller: CallerAuthority, signal?: AbortSignal): Promise<WaitResult> {
    const request = waitRequestSchema.parse(input);
    const captured = await this.serialize(async () => {
      this.authorize(caller, false);
      const cursor = this.state.revision;
      const workers = request.workers ?? Object.keys(this.state.workers);
      for (const worker of workers)
        if (!Object.hasOwn(this.state.workers, worker))
          throw new DomainError("invalid_input", `Unknown worker: ${worker}`, "workers");
      const selected =
        request.targets ??
        (request.next
          ? Object.values(this.state.assignments)
              .filter((assignment) => workers.includes(assignment.ref.worker))
              .map((assignment) => assignment.ref)
          : workers.map((worker) => ({
              run: this.state.run,
              worker,
              assignment: this.state.latest[worker],
            })));
      for (const ref of selected)
        if (
          ref.run !== this.state.run ||
          !Object.hasOwn(this.state.assignments, assignmentKey(ref))
        )
          throw new DomainError(
            "dependency_missing",
            `Unknown wait target: ${ref.run}/${ref.worker}/${ref.assignment}`,
            "targets",
          );
      const targets = [
        ...new Map(
          selected
            .filter(
              (ref) =>
                !request.next ||
                this.state.assignments[assignmentKey(ref)].execution.phase !== "ended",
            )
            .map((ref) => [assignmentKey(ref), ref]),
        ).values(),
      ];
      const targetKeys = new Set(targets.map(assignmentKey));
      const results = new Map(
        targets.flatMap((ref) => {
          const stored = this.state.results[assignmentKey(ref)];
          return stored ? [[assignmentKey(ref), stored.result] as const] : [];
        }),
      );
      const response = (status: WaitResult["status"], revision = cursor): WaitResult =>
        immutable({ status, targets, results: [...results.values()], cursor: revision });
      if (signal?.aborted || this.closing)
        return { completion: Promise.resolve(response("aborted")) };
      if (!targets.length) return { completion: Promise.resolve(response("nothing_pending")) };
      if (!request.next && targets.length === results.size)
        return { completion: Promise.resolve(response("settled")) };
      let complete = (_value: WaitResult): void => {};
      const completion = new Promise<WaitResult>((resolve) => {
        complete = resolve;
      });
      let unsubscribe = (): void => {};
      const cancel = (): void => finish("aborted", this.state.revision);
      const finish = (status: WaitResult["status"], revision: number): void => {
        unsubscribe();
        signal?.removeEventListener("abort", cancel);
        this.waitCancellations.delete(cancel);
        complete(response(status, revision));
      };
      unsubscribe = this.subscribe({ since: cursor }, caller, (event) => {
        if (event.kind !== "committed" || event.transition.kind !== "settled") return;
        const result = event.transition.result;
        const key = assignmentKey(result.ref);
        if (!targetKeys.has(key)) return;
        results.set(key, result);
        if (request.next || results.size === targets.length) finish("settled", event.revision);
      });
      this.waitCancellations.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      return { completion };
    });
    return captured.completion;
  }

  subscribe(
    input: unknown,
    caller: CallerAuthority,
    consume: (event: RuntimeEvent) => void | Promise<void>,
  ): () => void {
    this.authorize(caller, false);
    const request = subscriptionSchema.parse(input);
    if (this.closing) throw new DomainError("conflict", "Runtime is closing");
    if (request.since !== undefined && request.since > this.state.revision)
      throw new DomainError("conflict", "Subscription cursor is ahead of this run");
    const subscriber: Subscriber = { active: true, consume };
    this.subscribers.add(subscriber);
    // Registration, cursor capture and replay are synchronous: a commit cannot
    // slip between choosing the history and installing its live listener.
    if (request.since === undefined) {
      this.deliver(subscriber, {
        schemaVersion: 1,
        kind: "snapshot",
        id: `${this.store.manifest.run}/snapshot/${this.store.owner.epoch}/${this.state.revision}`,
        ownerEpoch: this.store.owner.epoch,
        revision: this.state.revision,
        snapshot: this.state,
      });
    } else {
      const frames = this.store.frames;
      for (const frame of frames)
        if (frame.record.revision > request.since) this.deliver(subscriber, this.event(frame));
    }
    return () => {
      subscriber.active = false;
      this.subscribers.delete(subscriber);
    };
  }

  private event(frame: JournalFrame): RuntimeEvent {
    return {
      schemaVersion: 1,
      kind: "committed",
      id: `${this.store.manifest.run}/transaction/${frame.record.revision}/${frame.digest}`,
      revision: frame.record.revision,
      ownerEpoch: this.store.owner.epoch,
      transition: frame.record.transition,
    };
  }

  private deliver(subscriber: Subscriber, event: RuntimeEvent): void {
    if (!subscriber.active) return;
    try {
      const delivery = subscriber.consume(immutable(event));
      if (delivery instanceof Promise)
        void delivery.catch((error: unknown) => this.subscriberFailed(subscriber, error));
    } catch (error) {
      this.subscriberFailed(subscriber, error);
    }
  }

  private subscriberFailed(subscriber: Subscriber, error: unknown): void {
    subscriber.active = false;
    this.subscribers.delete(subscriber);
    const diagnostic: RuntimeDiagnostic = {
      kind: "subscriber_failed",
      message: error instanceof Error ? error.message : String(error),
    };
    this.diagnostic(diagnostic);
  }

  private diagnostic(diagnostic: RuntimeDiagnostic): void {
    this.failures.push(diagnostic);
    if (this.failures.length > 100) this.failures.shift();
    try {
      this.options.onDiagnostic?.(immutable(diagnostic));
    } catch (cause) {
      this.failures.push({
        kind: "subscriber_failed",
        message: `Diagnostic observer failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  private publishActivity(
    ref: AssignmentRef,
    observation: Extract<BackendObservation, { kind: "activity" }>,
  ): void {
    const event: RuntimeEvent = {
      schemaVersion: 1,
      kind: "activity",
      source: observation.source,
      ordinal: observation.ordinal,
      ownerEpoch: this.store.owner.epoch,
      revision: this.state.revision,
      ref,
      text: observation.text,
      ...(observation.snapshot ? { snapshot: true as const } : {}),
    };
    const subscribers = [...this.subscribers];
    for (const subscriber of subscribers) this.deliver(subscriber, event);
  }

  diagnostics(): readonly RuntimeDiagnostic[] {
    return immutable(this.failures);
  }

  async recover(input: unknown, caller: CallerAuthority): Promise<RecoveryReceipt[]> {
    this.authorize(caller, true);
    if (this.closing) throw new DomainError("conflict", "Runtime is closing");
    const request = recoveryRequestSchema.parse(input);
    if (!this.execution) throw new DomainError("unsupported", "No execution backend is configured");
    await this.store.assertOwner();
    return this.execution.recover(request.targets);
  }

  async deliverNotifications(
    caller: CallerAuthority,
    options: { notificationId?: string } = {},
  ): Promise<NotificationDelivery[]> {
    this.authorize(caller, true);
    if (!this.delivery)
      throw new DomainError("unsupported", "No parent notification transport is attached");
    return this.delivery.deliver(options.notificationId);
  }

  async recordNotificationConsumption(
    id: string,
    checkpoint: ArtifactRef,
    caller: CallerAuthority,
  ): Promise<void> {
    this.authorize(caller, true);
    if (!this.delivery)
      throw new DomainError("unsupported", "No parent notification transport is attached");
    await this.delivery.consumed(id, checkpoint);
  }

  async dispatch(ref: AssignmentRef, caller: CallerAuthority): Promise<EffectObservation> {
    if (this.closing) throw new DomainError("conflict", "Runtime is closing");
    return this.serialize(async () => {
      this.authorize(caller, true);
      await this.store.assertOwner();
      const assignment = this.state.assignments[assignmentKey(ref)];
      if (!assignment) throw new DomainError("dependency_missing", "Assignment does not exist");
      const effectId = `${assignmentKey(ref)}:prepare`;
      const previous = this.state.effects[effectId];
      if (previous) {
        if (previous.status === "intent")
          return {
            status: "uncertain",
            detail:
              "An earlier dispatch intent has no confirmed observation; explicit reconciliation is required",
          };
        return immutable({
          status: previous.status,
          ...(previous.detail ? { detail: previous.detail } : {}),
        });
      }
      const port = this.options.effectPort;
      if (!port) throw new DomainError("unsupported", "No inert effect dispatcher is configured");
      const effect: Effect = { id: effectId, ref, kind: "prepare" };
      const intent: Transition = { kind: "effect_intent", effect };
      await this.commit({
        requestId: randomUUID(),
        payloadDigest: digestValue(intent),
        transition: intent,
      });
      let observation: EffectObservation;
      try {
        await this.store.assertOwner();
        observation = await port.dispatch(immutable(effect));
      } catch (error) {
        observation = {
          status: "uncertain",
          detail:
            error instanceof Error
              ? error.message
              : "Effect dispatch did not return a confirmed observation",
        };
      }
      const transition: Transition = { kind: "effect_observed", effectId, ...observation };
      await this.commit({
        requestId: randomUUID(),
        payloadDigest: digestValue(transition),
        transition,
      });
      return immutable(observation);
    });
  }

  async close(request: ShutdownRequest = { reason: "Runtime closed" }): Promise<ShutdownReceipt> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = (async (): Promise<ShutdownReceipt> => {
      await this.schedules?.close();
      const confirmed = (await this.execution?.close(request.reason)) ?? true;
      const applicationConfirmed = (await this.applications?.close()) ?? true;
      await this.delivery?.close();
      return this.serialize(async () => {
        for (const cancel of this.waitCancellations) cancel();
        for (const subscriber of this.subscribers) subscriber.active = false;
        this.subscribers.clear();
        if (!confirmed || !applicationConfirmed) {
          await this.store.close({ retainOwner: true });
          return {
            status: "owner_unconfirmed",
            revision: this.state.revision,
            reason:
              "Owned activity is unconfirmed; the run claim and workspace recovery evidence are retained",
          };
        }
        await this.checkpoint(true);
        await this.store.close();
        return { status: "closed", revision: this.state.revision };
      });
    })().finally(() => this.conversations.clear());
    return this.shutdown;
  }
}

function requestIdentity(input: unknown): string {
  if (
    input !== null &&
    typeof input === "object" &&
    "requestId" in input &&
    typeof input.requestId === "string" &&
    input.requestId.length &&
    !input.requestId.includes("\0")
  )
    return input.requestId;
  return "invalid-request";
}
