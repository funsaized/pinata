import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  BackendStartFailure,
  canonicalJson,
  digestValue,
  DomainError,
  type ArtifactPort,
  type ArtifactRef,
  type BackendCapabilities,
  type BackendHandle,
  type BackendIdentity,
  type BackendLaunch,
  type BackendObservation,
  type BackendOutcome,
  type BackendPort,
  type BackendReattach,
  type CleanupReceipt,
  type InboxMessage,
  type ObservationSource,
  type SessionCheckpoint,
  type TransportReceipt,
} from "../contracts/index.ts";
import { isMissing } from "../storage/io.ts";
import {
  attachSupervisor,
  launchSupervised,
  reconcileSupervisor,
  supervisionCapability,
  SupervisorLaunchError,
  type SupervisedProcess,
  type SupervisorIdentity,
} from "./supervision/index.ts";
import { readEvidence } from "./supervision/evidence.ts";
import {
  numberedPath,
  processEnrollmentSchema,
  processManifestSchema,
  processObservationSchema,
  processOutcomeSchema,
  processOptionsSchema,
  processReadySchema,
  processResponseSchema,
  processStopSchema,
  readCommands,
  readRecord,
  writeRecord,
  type ProcessAction,
  type ProcessManifest,
  type ProcessResponse,
  type WorkerProcessOptions,
} from "./process-transport.ts";

type Observe = (observation: BackendObservation, source?: ObservationSource) => Promise<void>;
export type ProcessBackendOptions = WorkerProcessOptions & { commandTimeoutMs?: number };
export type WorkerProcessHandle = BackendHandle & {
  detach(): Promise<void>;
  handoff(runtimeOwnerEpoch: string): Promise<void>;
};

function processDirectory(storeDirectory: string, attemptId: string): string {
  return join(storeDirectory, "workers", digestValue(attemptId));
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function retainSupervisorEvidence(
  identity: SupervisorIdentity,
  cleanup: CleanupReceipt,
  artifacts: ArtifactPort,
): Promise<CleanupReceipt> {
  const evidence = [];
  for (const reference of cleanup.evidence)
    evidence.push(await artifacts.put(await readEvidence(identity.directory, reference)));
  return { ...cleanup, evidence };
}

async function retainProcessOutput(
  identity: SupervisorIdentity,
  artifacts: ArtifactPort,
): Promise<ArtifactRef[]> {
  const output: ArtifactRef[] = [];
  for (const stream of ["stdout.bin", "stderr.bin", "events.jsonl"]) {
    try {
      output.push(await artifacts.put(await readFile(join(identity.directory, stream))));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return output;
}

export class ProcessHandle implements BackendHandle {
  readonly identity: BackendIdentity;
  readonly done: Promise<BackendOutcome>;
  private readonly directory: string;
  private readonly supervisor: SupervisedProcess;
  private readonly artifacts: ArtifactPort;
  private readonly observe: Observe;
  private readonly commandTimeoutMs: number;
  private runtimeOwnerEpoch: string;
  private active = true;
  private outcome?: BackendOutcome;
  private resolveDone: (outcome: BackendOutcome) => void = () => {};
  private rejectDone: (error: unknown) => void = () => {};
  private polling: Promise<void> = Promise.resolve();
  private commands: Promise<void> = Promise.resolve();
  private stopping?: ReturnType<BackendHandle["stop"]>;
  private removeAbort: () => void = () => {};

  constructor(options: {
    directory: string;
    manifest: ProcessManifest;
    supervisor: SupervisedProcess;
    artifacts: ArtifactPort;
    observe: Observe;
    runtimeOwnerEpoch: string;
    commandTimeoutMs: number;
  }) {
    this.identity = structuredClone(options.manifest.identity);
    this.directory = options.directory;
    this.supervisor = options.supervisor;
    this.artifacts = options.artifacts;
    this.observe = options.observe;
    this.runtimeOwnerEpoch = options.runtimeOwnerEpoch;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // A launch can fail before its caller receives the handle. The original
    // promise remains rejected for the caller once it owns the handle.
    void this.done.catch(() => {});
  }

  begin(signal: AbortSignal): void {
    const abort = () => {
      void this.stop("Worker cancellation requested").catch((error: unknown) =>
        this.rejectDone(error),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    this.removeAbort = () => signal.removeEventListener("abort", abort);
    this.polling = this.pollObservations().catch((error: unknown) => this.rejectDone(error));
    if (signal.aborted) abort();
  }

  private async pollObservations(): Promise<void> {
    let ordinal = 1;
    while (this.active) {
      const record = await readRecord(
        numberedPath(this.directory, "observations", ordinal),
        processObservationSchema,
      );
      if (record) {
        if (record.sourceId !== this.identity.id || record.ordinal !== ordinal)
          throw new Error("Worker observation identity or ordinal differs from its enrollment");
        await this.observe(record.observation, { sourceId: record.sourceId, ordinal });
        ordinal++;
        continue;
      }
      const ended = await readRecord(join(this.directory, "outcome.json"), processOutcomeSchema);
      if (ended) {
        if (ordinal <= ended.throughOrdinal) {
          const flushed = await readRecord(
            numberedPath(this.directory, "observations", ordinal),
            processObservationSchema,
          );
          if (!flushed) throw new Error("Worker outcome references a missing durable observation");
          continue;
        }
        // Outcome publication follows the observation stream flush.
        this.outcome = ended.outcome;
        this.resolveDone(ended.outcome);
        return;
      }
      const status = await this.supervisor.inspect();
      if (status.exit || status.phase === "failed") {
        if (await readRecord(join(this.directory, "outcome.json"), processOutcomeSchema)) continue;
        throw new Error("Worker process ended before publishing its durable outcome");
      }
      await delay(20);
    }
  }

  async waitReady(): Promise<void> {
    const deadline = performance.now() + this.commandTimeoutMs;
    while (true) {
      const ready = await readRecord(join(this.directory, "ready.json"), processReadySchema);
      if (ready?.status === "ready") return;
      if (ready?.status === "failed") throw new Error(`Worker setup failed: ${ready.error}`);
      const status = await this.supervisor.inspect();
      if (status.exit || status.phase === "failed") {
        if (await readRecord(join(this.directory, "ready.json"), processReadySchema)) continue;
        throw new Error("Worker exited during setup");
      }
      if (performance.now() >= deadline) throw new Error("Worker setup acknowledgment timed out");
      await delay(20);
    }
  }

  private request(id: string, command: ProcessAction): Promise<ProcessResponse> {
    const operation = this.commands.then(async () => {
      if (!this.active) throw new Error("Worker handle is detached or stopped");
      const prior = await readCommands(this.directory);
      let record = prior.find((entry) => entry.id === id);
      if (record && canonicalJson(record.command) !== canonicalJson(command))
        throw new Error("Worker command identity was reused with different input");
      if (!record) {
        record = {
          schemaVersion: 1,
          id,
          ordinal: prior.length + 1,
          runtimeOwnerEpoch: this.runtimeOwnerEpoch,
          command,
        };
        await writeRecord(numberedPath(this.directory, "commands", record.ordinal), record);
      }
      const deadline = performance.now() + this.commandTimeoutMs;
      while (true) {
        const response = await readRecord(
          numberedPath(this.directory, "responses", record.ordinal),
          processResponseSchema,
        );
        if (response) {
          if (response.id !== id || response.ordinal !== record.ordinal)
            throw new Error("Worker response does not acknowledge the requested command");
          if (response.status === "error") throw new Error(response.error);
          return response;
        }
        const status = await this.supervisor.inspect();
        if (status.exit || status.phase === "failed") {
          if (
            await readRecord(
              numberedPath(this.directory, "responses", record.ordinal),
              processResponseSchema,
            )
          )
            continue;
          throw new Error("Worker ended before its command acknowledgment");
        }
        if (performance.now() >= deadline)
          throw new Error("Worker command acknowledgment timed out");
        await delay(20);
      }
    });
    this.commands = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  async claimRuntime(runtimeOwnerEpoch: string): Promise<void> {
    const response = await this.request(`attach/${runtimeOwnerEpoch}`, {
      action: "attach",
      runtimeOwnerEpoch,
    });
    if (response.status !== "ok" || response.runtimeOwnerEpoch !== runtimeOwnerEpoch)
      throw new Error("Worker runtime attachment was not durably acknowledged");
    this.runtimeOwnerEpoch = runtimeOwnerEpoch;
  }

  async input(message: InboxMessage): Promise<TransportReceipt> {
    const response = await this.request(`input/${message.id}`, {
      action: "input",
      message: { ...message, state: "recorded", attempts: [] },
    });
    if (response.status !== "ok" || !response.receipt)
      throw new Error("Worker input receipt is missing");
    return response.receipt;
  }

  async checkpoint(): Promise<SessionCheckpoint> {
    const response = await this.request(`checkpoint/${randomUUID()}`, { action: "checkpoint" });
    if (response.status !== "ok" || !response.checkpoint)
      throw new Error("Worker checkpoint receipt is missing");
    return response.checkpoint;
  }

  async handoff(runtimeOwnerEpoch: string): Promise<void> {
    if (this.supervisor.identity.lifetime !== "surviving")
      throw new DomainError("unsupported", "Attached workers cannot survive a runtime handoff");
    await this.claimRuntime(runtimeOwnerEpoch);
    await this.detach();
  }

  async detach(): Promise<void> {
    if (this.stopping) throw new Error("Stopping workers cannot detach");
    if (this.supervisor.identity.lifetime !== "surviving")
      throw new DomainError("unsupported", "Attached workers cannot detach from their runtime");
    this.active = false;
    this.removeAbort();
    await this.polling;
    this.supervisor.detach();
  }

  stop(reason: string): ReturnType<BackendHandle["stop"]> {
    if (!this.stopping) this.stopping = this.stopOwned(reason);
    return this.stopping;
  }

  private async stopOwned(reason: string): ReturnType<BackendHandle["stop"]> {
    const ownedHandle = this.active;
    this.removeAbort();
    const reasons: string[] = [];
    let stopped: Awaited<ReturnType<BackendHandle["stop"]>> | undefined;
    try {
      const ready = await readRecord(join(this.directory, "ready.json"), processReadySchema);
      if (ready?.status === "failed" && ready.cleanup) stopped = { cleanup: ready.cleanup };
      else {
        const response = await this.request("stop", { action: "stop", reason });
        if (response.status !== "ok" || !response.stopped)
          throw new Error("Worker stop receipt is missing");
        stopped = response.stopped;
      }
      if (stopped.cleanup.status === "unconfirmed") reasons.push(...stopped.cleanup.reasons);
    } catch (error) {
      reasons.push(`Worker session cleanup is unconfirmed: ${errorMessage(error)}`);
    }
    const guardianCleanup = await this.supervisor.stop({ reason });
    if (guardianCleanup.status === "unconfirmed") reasons.push(...guardianCleanup.reasons);
    this.active = false;
    await this.polling;
    const evidence = [...(stopped?.cleanup.evidence ?? [])];
    let output: ArtifactRef[] = [];
    try {
      evidence.push(
        ...(
          await retainSupervisorEvidence(this.supervisor.identity, guardianCleanup, this.artifacts)
        ).evidence,
      );
      output = await retainProcessOutput(this.supervisor.identity, this.artifacts);
    } catch (error) {
      reasons.push(`Worker evidence retention failed: ${errorMessage(error)}`);
    }
    const identities = [
      this.identity.id,
      ...guardianCleanup.identities,
      ...(stopped?.cleanup.identities ?? []),
    ];
    const cleanup: CleanupReceipt = reasons.length
      ? {
          status: "unconfirmed",
          ownerEpoch: this.identity.ownerEpoch,
          identities,
          evidence,
          reasons,
        }
      : { status: "stopped", ownerEpoch: this.identity.ownerEpoch, identities, evidence };
    const retained = await readRecord(join(this.directory, "outcome.json"), processOutcomeSchema);
    const outcome = stopped?.outcome ?? this.outcome ?? retained?.outcome;
    const receipt = {
      cleanup,
      ...(outcome ? { outcome: { ...outcome, artifacts: [...outcome.artifacts, ...output] } } : {}),
      ...(stopped?.checkpoint ? { checkpoint: stopped.checkpoint } : {}),
    };
    if (ownedHandle)
      await writeRecord(
        join(this.directory, "backend-stop.json"),
        processStopSchema.parse(receipt),
      );
    return receipt;
  }
}

export class ProcessBackend implements BackendPort {
  readonly kind = "process" as const;
  readonly capabilities: BackendCapabilities;
  private readonly options: WorkerProcessOptions;
  private readonly commandTimeoutMs: number;

  constructor(options: ProcessBackendOptions) {
    this.options = processOptionsSchema.parse({
      agentDir: resolve(options.agentDir),
      ...(options.codemode === undefined ? {} : { codemode: options.codemode }),
      ...(options.extensions
        ? { extensions: options.extensions.map((path) => resolve(path)) }
        : {}),
      ...(options.bootstrapModule ? { bootstrapModule: resolve(options.bootstrapModule) } : {}),
      ...(options.nodeCommand ? { nodeCommand: options.nodeCommand } : {}),
    });
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    const capability = supervisionCapability();
    this.capabilities = {
      ...capability,
      steer: true,
      continuation: true,
      conversationSeed: false,
      surviving: true,
    };
  }

  async start(
    launch: BackendLaunch,
    observe: Observe,
    signal: AbortSignal,
  ): Promise<ProcessHandle> {
    signal.throwIfAborted();
    if (!this.capabilities.available)
      throw new DomainError(
        "unsupported",
        this.capabilities.reason ?? "Process backend unavailable",
      );
    const directory = processDirectory(launch.storeDirectory, launch.attemptId);
    const identity: BackendIdentity = {
      id: randomUUID(),
      kind: this.kind,
      ownerEpoch: launch.ownerEpoch,
    };
    const initialMessages = await launch.artifacts.put(
      Buffer.from(canonicalJson(launch.initialMessages)),
    );
    const brief = await launch.artifacts.put(Buffer.from(canonicalJson(launch.brief)));
    const { artifacts: _artifacts, ...wire } = launch;
    const manifest = processManifestSchema.parse({
      schemaVersion: 1,
      identity,
      options: this.options,
      launch: { ...wire, initialMessages, brief },
    });
    await writeRecord(join(directory, "manifest.json"), manifest);
    await mkdir(this.options.agentDir, { recursive: true, mode: 0o700 });
    let supervisor: SupervisedProcess | undefined;
    let handle: ProcessHandle | undefined;
    try {
      supervisor = await launchSupervised({
        directory: join(directory, "guardian"),
        command: this.options.nodeCommand ?? process.execPath,
        args: [fileURLToPath(new URL("./process-worker.ts", import.meta.url)), directory],
        cwd: launch.cwd,
        ownerEpoch: launch.ownerEpoch,
        lifetime: launch.worker.lifetime,
        nodeCommand: this.options.nodeCommand,
        async onEnrolled(owned) {
          const enrollment = processEnrollmentSchema.parse({
            schemaVersion: 1,
            identity,
            supervisor: owned,
          });
          await writeRecord(join(directory, "enrollment.json"), enrollment);
          const evidence = await launch.artifacts.put(Buffer.from(canonicalJson(enrollment)));
          const observation: BackendObservation = {
            kind: "enrolled",
            identity,
            evidence: [evidence],
          };
          await writeRecord(numberedPath(directory, "observations", 1), {
            schemaVersion: 1,
            sourceId: identity.id,
            ordinal: 1,
            observation,
          });
          await observe(observation, { sourceId: identity.id, ordinal: 1 });
          signal.throwIfAborted();
        },
      });
      handle = new ProcessHandle({
        directory,
        manifest,
        supervisor,
        artifacts: launch.artifacts,
        observe,
        runtimeOwnerEpoch: launch.ownerEpoch,
        commandTimeoutMs: this.commandTimeoutMs,
      });
      await handle.waitReady();
      handle.begin(signal);
      signal.throwIfAborted();
      return handle;
    } catch (error) {
      let cleanup: CleanupReceipt;
      if (handle) cleanup = (await handle.stop("Process backend setup failed")).cleanup;
      else if (supervisor)
        cleanup = await supervisor.stop({ reason: "Process backend setup failed" });
      else if (error instanceof SupervisorLaunchError) cleanup = error.cleanup;
      else
        cleanup = {
          status: "unconfirmed",
          ownerEpoch: launch.ownerEpoch,
          identities: [identity.id],
          evidence: [],
          reasons: [`Process launch cleanup is unconfirmed: ${errorMessage(error)}`],
        };
      if (!handle) {
        const evidence = [];
        for (const reference of cleanup.evidence)
          evidence.push(
            await launch.artifacts.put(await readEvidence(join(directory, "guardian"), reference)),
          );
        cleanup = { ...cleanup, evidence };
      }
      throw new BackendStartFailure(
        errorMessage(error),
        { identity, cleanup, artifacts: cleanup.evidence },
        { cause: error },
      );
    }
  }

  async reattach(
    request: BackendReattach,
    observe: Observe,
    signal: AbortSignal,
  ): Promise<WorkerProcessHandle> {
    signal.throwIfAborted();
    const directory = processDirectory(request.storeDirectory, request.attemptId);
    const manifest = await readRecord(join(directory, "manifest.json"), processManifestSchema);
    const enrollment = await readRecord(
      join(directory, "enrollment.json"),
      processEnrollmentSchema,
    );
    if (
      !manifest ||
      !enrollment ||
      canonicalJson(manifest.launch.ref) !== canonicalJson(request.ref) ||
      manifest.launch.attemptId !== request.attemptId ||
      manifest.launch.ownerEpoch !== request.ownerEpoch ||
      enrollment.supervisor.ownerEpoch !== request.ownerEpoch ||
      manifest.launch.storeDirectory !== request.storeDirectory ||
      enrollment.supervisor.directory !== join(directory, "guardian") ||
      manifest.identity.kind !== this.kind ||
      canonicalJson(manifest.identity) !== canonicalJson(enrollment.identity) ||
      (request.identity && canonicalJson(request.identity) !== canonicalJson(manifest.identity))
    )
      throw new DomainError(
        "owner_unconfirmed",
        "Retained worker enrollment does not match this attempt",
      );
    let supervisor: SupervisedProcess;
    try {
      supervisor = await attachSupervisor(enrollment.supervisor);
    } catch (error) {
      return this.recoverStopped(request, manifest, enrollment.supervisor, observe, signal, error);
    }
    const handle = new ProcessHandle({
      directory,
      manifest,
      supervisor,
      artifacts: request.artifacts,
      observe,
      runtimeOwnerEpoch: request.runtimeOwnerEpoch,
      commandTimeoutMs: this.commandTimeoutMs,
    });
    try {
      await handle.waitReady();
      await handle.claimRuntime(request.runtimeOwnerEpoch);
      handle.begin(signal);
      return handle;
    } catch (error) {
      if (enrollment.supervisor.lifetime === "surviving") await handle.detach();
      else await handle.stop("Runtime reattachment failed");
      throw error;
    }
  }

  private async recoverStopped(
    request: BackendReattach,
    manifest: ProcessManifest,
    supervisor: SupervisorIdentity,
    observe: Observe,
    signal: AbortSignal,
    attachmentError: unknown,
  ): Promise<WorkerProcessHandle> {
    const directory = processDirectory(request.storeDirectory, request.attemptId);
    const ended = await readRecord(join(directory, "outcome.json"), processOutcomeSchema);
    const command = (await readCommands(directory)).find(
      (entry) => entry.id === "stop" && entry.command.action === "stop",
    );
    const response = command
      ? await readRecord(
          numberedPath(directory, "responses", command.ordinal),
          processResponseSchema,
        )
      : undefined;
    const stopped =
      response?.status === "ok" &&
      response.id === command?.id &&
      response.ordinal === command?.ordinal
        ? response.stopped
        : undefined;
    if (
      !ended ||
      !stopped?.outcome ||
      stopped.cleanup.status !== "stopped" ||
      stopped.cleanup.ownerEpoch !== request.ownerEpoch ||
      canonicalJson(stopped.outcome) !== canonicalJson(ended.outcome)
    )
      throw new DomainError(
        "owner_unconfirmed",
        `Worker has no matching durable terminal outcome and stop receipt: ${errorMessage(attachmentError)}`,
      );
    signal.throwIfAborted();
    const guardian = await retainSupervisorEvidence(
      supervisor,
      await reconcileSupervisor(supervisor, {
        reason: `Runtime ${request.runtimeOwnerEpoch} recovered stopped attempt ${request.attemptId}`,
      }),
      request.artifacts,
    );
    if (guardian.status !== "stopped")
      throw new BackendStartFailure(
        "Stopped worker supervision remains unconfirmed",
        {
          identity: manifest.identity,
          cleanup: guardian,
          artifacts: guardian.evidence,
        },
        { cause: attachmentError },
      );
    const output = await retainProcessOutput(supervisor, request.artifacts);
    const outcome: BackendOutcome = {
      ...ended.outcome,
      artifacts: [...ended.outcome.artifacts, ...output],
    };
    const cleanup: CleanupReceipt = {
      status: "stopped",
      ownerEpoch: request.ownerEpoch,
      identities: [manifest.identity.id, ...stopped.cleanup.identities, ...guardian.identities],
      evidence: [...stopped.cleanup.evidence, ...guardian.evidence],
    };
    const receipt = processStopSchema.parse({
      cleanup,
      outcome,
      ...(stopped.checkpoint ? { checkpoint: stopped.checkpoint } : {}),
    });
    await writeRecord(
      join(directory, `recovered-stop-${digestValue(request.runtimeOwnerEpoch)}.json`),
      receipt,
    );
    for (let ordinal = 1; ordinal <= ended.throughOrdinal; ordinal++) {
      signal.throwIfAborted();
      const record = await readRecord(
        numberedPath(directory, "observations", ordinal),
        processObservationSchema,
      );
      if (!record || record.ordinal !== ordinal || record.sourceId !== manifest.identity.id)
        throw new DomainError(
          "owner_unconfirmed",
          "Stopped worker observation stream is incomplete or mismatched",
        );
      await observe(record.observation, { sourceId: record.sourceId, ordinal });
    }
    return {
      identity: structuredClone(manifest.identity),
      done: Promise.resolve(outcome),
      input: async () => ({ status: "undelivered" }),
      stop: async () => structuredClone(receipt),
      async checkpoint() {
        const checkpoint = stopped.checkpoint ?? outcome.session;
        if (!checkpoint)
          throw new DomainError(
            "context_unavailable",
            "Stopped worker has no retained conversation checkpoint",
          );
        return structuredClone(checkpoint);
      },
      async detach() {
        throw new DomainError("unsupported", "Stopped worker has no live process to detach");
      },
      async handoff() {
        throw new DomainError("unsupported", "Stopped worker has no live process to hand off");
      },
    };
  }
}
