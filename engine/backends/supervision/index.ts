import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { cleanupReceiptSchema, type CleanupReceipt } from "../../contracts/backend.ts";
import type { ArtifactRef } from "../../contracts/common.ts";
import { canonicalJson } from "../../contracts/digest.ts";
import { isMissing, publishImmutable } from "../../storage/io.ts";
import { ControlClient } from "./client.ts";
import {
  bootstrapSchema,
  payloadSchema,
  publicSupervisorId,
  savedCleanupSchema,
  statusSchema,
  stopFileSchema,
  stopResponseSchema,
  supervisorIdentitySchema,
  type SupervisorEvent,
  type SupervisorIdentity,
  type SupervisorStatus,
} from "./contracts.ts";
import { readEvidence, retainEvidence, writeProjection } from "./evidence.ts";
import { observeProcess, observeProcesses, remainingActivity } from "./processes.ts";
import { windowsHelperExecutable } from "./windows-helper.ts";

export type { SupervisorEvent, SupervisorIdentity, SupervisorStatus } from "./contracts.ts";
export { publicSupervisorId } from "./contracts.ts";
export { observeProcess } from "./processes.ts";

export type LaunchOptions = {
  directory: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  ownerEpoch: string;
  lifetime: "attached" | "surviving";
  nodeCommand?: string;
  signal?: AbortSignal;
  onEnrolled(identity: SupervisorIdentity): Promise<void>;
  onEvent?(event: SupervisorEvent): void;
};
export type StopOptions = { reason?: string; graceMs?: number; confirmationMs?: number };

export class SupervisorLaunchError extends Error {
  readonly cleanup: CleanupReceipt;
  constructor(message: string, cleanup: CleanupReceipt, options?: ErrorOptions) {
    super(message, options);
    this.name = "SupervisorLaunchError";
    this.cleanup = cleanup;
  }
}

export function supervisionCapability(platform: NodeJS.Platform = process.platform): {
  available: boolean;
  cleanup: "confirmed" | "unverified";
  reason?: string;
} {
  if (platform === "linux" || platform === "darwin" || platform === "win32")
    return { available: true, cleanup: "confirmed" };
  return {
    available: false,
    cleanup: "unverified",
    reason: `No supervisor is available for ${platform}`,
  };
}

async function validateLocalIdentity(identity: SupervisorIdentity): Promise<void> {
  if (identity.host !== hostname() || identity.platform !== process.platform)
    throw new Error("Supervisor belongs to another host or platform");
  if ((await realpath(identity.directory)) !== identity.directory)
    throw new Error("Supervisor directory is not canonical");
  const persisted = supervisorIdentitySchema.parse(
    JSON.parse(await readFile(join(identity.directory, "identity.json"), "utf8")),
  );
  if (canonicalJson(persisted) !== canonicalJson(identity))
    throw new Error("Supervisor identity differs from its retained enrollment");
}

async function savedCleanup(identity: SupervisorIdentity): Promise<CleanupReceipt | undefined> {
  try {
    const saved = savedCleanupSchema.parse(
      JSON.parse(await readFile(join(identity.directory, "cleanup.json"), "utf8")),
    );
    if (saved.supervisor !== identity.id || saved.receipt.ownerEpoch !== identity.ownerEpoch)
      throw new Error("Saved cleanup belongs to another supervisor");
    const receiptBytes = await readEvidence(identity.directory, saved.receiptArtifact);
    const expected = { schemaVersion: 1, supervisor: saved.supervisor, receipt: saved.receipt };
    if (canonicalJson(JSON.parse(receiptBytes.toString("utf8"))) !== canonicalJson(expected))
      throw new Error("Saved cleanup differs from its immutable receipt evidence");
    for (const artifact of saved.receipt.evidence) await readEvidence(identity.directory, artifact);
    return saved.receipt;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function cleanupReceipt(
  identity: SupervisorIdentity,
  reasons: string[],
  observations: unknown,
  evidence: ArtifactRef[] = [],
): Promise<CleanupReceipt> {
  const identities = [publicSupervisorId(identity)];
  try {
    const reference = await retainEvidence(identity.directory, {
      schemaVersion: 1,
      supervisor: identity.id,
      ownerEpoch: identity.ownerEpoch,
      observedAt: new Date().toISOString(),
      reasons,
      observations,
    });
    const receipt = cleanupReceiptSchema.parse(
      reasons.length
        ? {
            status: "unconfirmed",
            ownerEpoch: identity.ownerEpoch,
            identities,
            reasons,
            evidence: [...evidence, reference],
          }
        : {
            status: "stopped",
            ownerEpoch: identity.ownerEpoch,
            identities,
            evidence: [...evidence, reference],
          },
    );
    const saved = {
      schemaVersion: 1,
      supervisor: identity.id,
      receipt,
    };
    const receiptArtifact = await retainEvidence(identity.directory, saved);
    await writeProjection(identity.directory, "cleanup.json", { ...saved, receiptArtifact });
    return receipt;
  } catch (error) {
    return {
      status: "unconfirmed",
      ownerEpoch: identity.ownerEpoch,
      identities,
      reasons: [
        ...reasons,
        `Cleanup evidence could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      ],
      evidence,
    };
  }
}

export class SupervisedProcess {
  readonly identity: SupervisorIdentity;
  readonly exit: Promise<{ code: number | null; signal: string | null }>;
  readonly outputDrained: Promise<{ stdout: number; stderr: number }>;
  readonly closed: Promise<void>;
  private client: ControlClient | undefined;
  private readonly child?: ChildProcess;
  private readonly listeners = new Set<(event: SupervisorEvent) => void>();
  private readonly errors: string[] = [];
  private resolveExit: (exit: { code: number | null; signal: string | null }) => void = () => {};
  private resolveClosed: () => void = () => {};
  private resolveOutputDrained: (lengths: { stdout: number; stderr: number }) => void = () => {};
  private rejectOutputDrained: (error: unknown) => void = () => {};
  private cleanup: Promise<CleanupReceipt> | undefined;
  private detachAbort?: () => void;
  private abortSignal?: AbortSignal;

  private constructor(
    identity: SupervisorIdentity,
    options: { child?: ChildProcess; onEvent?: (event: SupervisorEvent) => void },
  ) {
    this.identity = Object.freeze({
      ...structuredClone(identity),
      process: Object.freeze(structuredClone(identity.process)),
      scope: Object.freeze(structuredClone(identity.scope)),
      endpoint: Object.freeze(structuredClone(identity.endpoint)),
    });
    this.child = options.child;
    if (options.onEvent) this.listeners.add(options.onEvent);
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.outputDrained = new Promise((resolve, reject) => {
      this.resolveOutputDrained = resolve;
      this.rejectOutputDrained = reject;
    });
    // Callers that only need process cleanup may not consume output. Callers
    // requiring complete bytes still receive the original rejection.
    void this.outputDrained.catch(() => {});
  }

  static async connect(
    input: SupervisorIdentity,
    options: { child?: ChildProcess; onEvent?: (event: SupervisorEvent) => void } = {},
  ): Promise<SupervisedProcess> {
    const identity = supervisorIdentitySchema.parse(input);
    await validateLocalIdentity(identity);
    if (
      identity.platform === "win32"
        ? identity.scope.kind !== "windows-job" || identity.process.group !== 0
        : identity.scope.kind !== "posix-group" ||
          identity.scope.group !== identity.process.pid ||
          identity.process.group !== identity.process.pid
    )
      throw new Error("Supervisor does not describe a resident owned group");
    const handle = new SupervisedProcess(identity, options);
    try {
      const client = await ControlClient.open(identity, (event) => handle.receive(event));
      handle.client = client;
      void client.closed.then(() => {
        handle.resolveClosed();
        handle.rejectOutputDrained(new Error("Guardian closed before output drain was confirmed"));
      });
      const observed = await client.request({ action: "ping" });
      const expected = {
        id: identity.id,
        ownerEpoch: identity.ownerEpoch,
        process: identity.process,
        scope: identity.scope,
        host: identity.host,
      };
      if (canonicalJson(observed) !== canonicalJson(expected))
        throw new Error("Live guardian identity differs from the retained enrollment");
      const status = statusSchema.parse(await client.request({ action: "observe" }));
      if (status.exit) handle.resolveExit(status.exit);
      if (status.outputDrained)
        handle.resolveOutputDrained({ stdout: status.stdout, stderr: status.stderr });
      return handle;
    } catch (error) {
      handle.client?.close();
      throw error;
    }
  }

  private receive(event: SupervisorEvent): void {
    if (event.source !== this.identity.id) {
      this.errors.push("Event source differs from guardian identity");
      return;
    }
    if (event.kind === "exit") this.resolveExit({ code: event.code, signal: event.signal });
    if (event.kind === "output_drained")
      this.resolveOutputDrained({ stdout: event.stdout, stderr: event.stderr });
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(event));
      } catch (error) {
        this.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  events(consume: (event: SupervisorEvent) => void): () => void {
    this.listeners.add(consume);
    return () => {
      this.listeners.delete(consume);
    };
  }

  diagnostics(): readonly string[] {
    return [...this.errors];
  }

  async start(payload: z.input<typeof payloadSchema>): Promise<void> {
    if (!this.client) throw new Error("Supervisor is disconnected");
    if (this.cleanup || this.abortSignal?.aborted)
      throw new Error("Supervisor launch is cancelled or stopping");
    statusSchema.parse(
      await this.client.request({ action: "start", payload: payloadSchema.parse(payload) }),
    );
  }

  async writeInput(text: string): Promise<void> {
    if (!this.client) throw new Error("Supervisor is disconnected");
    if (this.cleanup) throw new Error("Supervisor is stopping");
    await this.client.request({ action: "input", text });
  }

  async closeInput(): Promise<void> {
    if (!this.client) throw new Error("Supervisor is disconnected");
    if (this.cleanup) throw new Error("Supervisor is stopping");
    await this.client.request({ action: "input_end" });
  }

  async inspect(): Promise<SupervisorStatus> {
    if (!this.client) throw new Error("Supervisor is disconnected");
    return statusSchema.parse(await this.client.request({ action: "inspect" }));
  }

  async enroll(pid: number): Promise<SupervisorStatus> {
    if (!this.client) throw new Error("Supervisor is disconnected");
    return statusSchema.parse(await this.client.request({ action: "enroll", pid }));
  }

  async readOutput(options: {
    stream: "stdout" | "stderr";
    offset: number;
    maxBytes?: number;
  }): Promise<{ bytes: Buffer; nextOffset: number }> {
    const offset = z.number().int().nonnegative().parse(options.offset);
    const maxBytes = z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024)
      .parse(options.maxBytes ?? 64 * 1024);
    const stream = z.enum(["stdout", "stderr"]).parse(options.stream);
    const file = await open(join(this.identity.directory, `${stream}.bin`), "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      return { bytes: buffer.subarray(0, bytesRead), nextOffset: offset + bytesRead };
    } finally {
      await file.close();
    }
  }

  readEvidence(reference: ArtifactRef): Promise<Buffer> {
    return readEvidence(this.identity.directory, reference);
  }

  bindAbort(signal?: AbortSignal): void {
    if (!signal) return;
    this.abortSignal = signal;
    const abort = () => {
      void this.stop({ reason: "Launch cancellation requested" }).catch((error: unknown) =>
        this.errors.push(error instanceof Error ? error.message : String(error)),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    this.detachAbort = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  }

  detach(): void {
    if (this.identity.lifetime !== "surviving")
      throw new Error("Attached supervision cannot be detached from its host");
    if (this.cleanup) throw new Error("Stopping supervision cannot be detached");
    this.detachAbort?.();
    this.client?.close();
    this.client = undefined;
    if (this.child?.connected) this.child.disconnect();
    this.child?.stderr?.destroy();
    this.child?.unref();
    this.listeners.clear();
  }

  stop(options: StopOptions = {}): Promise<CleanupReceipt> {
    if (!this.cleanup) this.cleanup = this.confirmStop(options);
    return this.cleanup;
  }

  private async confirmStop(options: StopOptions): Promise<CleanupReceipt> {
    this.detachAbort?.();
    let saved: CleanupReceipt | undefined;
    try {
      saved = await savedCleanup(this.identity);
    } catch (error) {
      return {
        status: "unconfirmed",
        ownerEpoch: this.identity.ownerEpoch,
        identities: [publicSupervisorId(this.identity)],
        reasons: [
          `Retained cleanup evidence cannot be trusted: ${error instanceof Error ? error.message : String(error)}`,
        ],
        evidence: [],
      };
    }
    if (saved?.status === "stopped") return saved;
    const graceMs = z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .parse(options.graceMs ?? 100);
    const confirmationMs = z
      .number()
      .int()
      .min(1)
      .max(30_000)
      .parse(options.confirmationMs ?? 3000);
    let response: z.infer<typeof stopResponseSchema>;
    try {
      if (!this.client) throw new Error("Guardian live control is unavailable");
      response = stopResponseSchema.parse(
        await this.client.request({
          action: "stop",
          reason: options.reason ?? "Owned activity stop requested",
          graceMs,
        }),
      );
    } catch (error) {
      this.client?.close();
      return cleanupReceipt(
        this.identity,
        [
          `Guardian identity or stop acknowledgment is unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
        ],
        { action: "stop-refused" },
      );
    }
    const deadline = performance.now() + graceMs + confirmationMs;
    let last: unknown;
    try {
      for (;;) {
        const windows = this.identity.scope.kind === "windows-job";
        const observedGuardian = windows
          ? await observeProcess(this.identity.process.pid)
          : undefined;
        const observations = windows
          ? observedGuardian
            ? [observedGuardian]
            : []
          : await observeProcesses();
        const activeGuardian = observations.some(
          (process) => process.pid === this.identity.process.pid && !process.state.startsWith("Z"),
        );
        if (!activeGuardian) {
          const stop = stopFileSchema.parse(
            JSON.parse(await readFile(join(this.identity.directory, "stop.json"), "utf8")),
          );
          const stopBytes = await readEvidence(this.identity.directory, stop.artifact);
          if (canonicalJson(JSON.parse(stopBytes.toString("utf8"))) !== canonicalJson(stop.record))
            throw new Error("Stop projection differs from its immutable evidence");
          if (
            stop.record.id !== response.stopId ||
            stop.record.supervisor !== this.identity.id ||
            stop.record.ownerEpoch !== this.identity.ownerEpoch ||
            stop.record.phase !== "armed"
          )
            throw new Error("Guardian disappeared without its matching final stop evidence");
          if (
            windows &&
            (this.identity.scope.kind !== "windows-job" ||
              !stop.record.windows ||
              stop.record.windows.jobName !== this.identity.scope.name ||
              stop.record.windows.launcherId !== this.identity.scope.launcherId)
          )
            throw new Error("Guardian has no matching native empty-and-closed Job Object receipt");
          const remaining = windows
            ? observations
            : remainingActivity(observations, this.identity.process.pid, stop.record.enrolled);
          last = { stop: stop.record, remaining };
          if (!remaining.length) {
            const reasons = [...stop.record.observationErrors];
            if (stop.record.escaped.length)
              reasons.push(
                "Enrolled activity escaped the owned group; cleanup requires explicit reconciliation",
              );
            this.client?.close();
            this.listeners.clear();
            return cleanupReceipt(this.identity, reasons, last, [response.evidence, stop.artifact]);
          }
        } else last = { guardian: "still-observed" };
        if (performance.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      this.client?.close();
      return cleanupReceipt(
        this.identity,
        ["Enrolled activity remains live or unknown after the cleanup allowance"],
        last,
        [response.evidence],
      );
    } catch (error) {
      this.client?.close();
      return cleanupReceipt(
        this.identity,
        [
          `Cleanup observation is unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
        ],
        last,
        [response.evidence],
      );
    }
  }
}

export async function attachSupervisor(
  identity: SupervisorIdentity,
  options: { onEvent?: (event: SupervisorEvent) => void } = {},
): Promise<SupervisedProcess> {
  return SupervisedProcess.connect(identity, options);
}

export async function stopSupervisor(
  input: SupervisorIdentity,
  options: StopOptions = {},
): Promise<CleanupReceipt> {
  const identity = supervisorIdentitySchema.parse(input);
  try {
    await validateLocalIdentity(identity);
    const saved = await savedCleanup(identity);
    if (saved?.status === "stopped") return saved;
    return await (await attachSupervisor(identity)).stop(options);
  } catch (error) {
    return {
      status: "unconfirmed",
      ownerEpoch: identity.ownerEpoch,
      identities: [publicSupervisorId(identity)],
      reasons: [
        `Live supervisor attachment is unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      evidence: [],
    };
  }
}

export async function reconcileSupervisor(
  input: SupervisorIdentity,
  options: { reason: string },
): Promise<CleanupReceipt> {
  const identity = supervisorIdentitySchema.parse(input);
  if (!options.reason.trim()) throw new Error("Supervisor reconciliation requires an audit reason");
  try {
    await validateLocalIdentity(identity);
  } catch (error) {
    return {
      status: "unconfirmed",
      ownerEpoch: identity.ownerEpoch,
      identities: [publicSupervisorId(identity)],
      evidence: [],
      reasons: [
        `Supervisor reconciliation identity is unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  let observations: unknown = { kind: "offline-reconciliation", reason: options.reason };
  try {
    const saved = await savedCleanup(identity);
    if (saved?.status === "stopped") return saved;
    const stop = stopFileSchema.parse(
      JSON.parse(await readFile(join(identity.directory, "stop.json"), "utf8")),
    );
    const bytes = await readEvidence(identity.directory, stop.artifact);
    if (canonicalJson(JSON.parse(bytes.toString("utf8"))) !== canonicalJson(stop.record))
      throw new Error("Stop projection differs from its immutable evidence");
    if (
      stop.record.supervisor !== identity.id ||
      stop.record.ownerEpoch !== identity.ownerEpoch ||
      stop.record.phase !== "armed"
    )
      throw new Error("No matching armed guardian stop evidence is retained");
    if (
      !stop.record.enrolled.some(
        (process) =>
          process.pid === identity.process.pid && process.group === identity.process.group,
      )
    )
      throw new Error("Armed stop evidence does not include its resident guardian");
    if (
      identity.scope.kind === "windows-job" &&
      (!stop.record.windows ||
        stop.record.windows.jobName !== identity.scope.name ||
        stop.record.windows.launcherId !== identity.scope.launcherId)
    )
      throw new Error("No matching native empty-and-closed Job Object receipt is retained");
    const guardian =
      identity.scope.kind === "windows-job"
        ? await observeProcess(identity.process.pid)
        : undefined;
    const remaining =
      identity.scope.kind === "windows-job"
        ? guardian
          ? [guardian]
          : []
        : remainingActivity(await observeProcesses(), identity.process.pid, [
            identity.process,
            ...stop.record.enrolled,
            ...stop.record.escaped,
          ]);
    observations = {
      kind: "offline-reconciliation",
      reason: options.reason,
      stop: stop.record,
      remaining,
    };
    const reasons = [...stop.record.observationErrors];
    if (remaining.length)
      reasons.push("Enrolled, escaped, reused-PID or group activity remains live or unknown");
    // This explicit inspection never sends a signal. An armed guardian record and
    // current absence are both necessary; a dead PID alone grants no authority.
    return cleanupReceipt(identity, reasons, observations, [
      ...(saved?.evidence ?? []),
      stop.artifact,
    ]);
  } catch (error) {
    return cleanupReceipt(
      identity,
      [
        `Supervisor reconciliation is unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      observations,
    );
  }
}

export async function launchSupervised(options: LaunchOptions): Promise<SupervisedProcess> {
  const emptyCleanup: CleanupReceipt = {
    status: "stopped",
    ownerEpoch: options.ownerEpoch,
    identities: [],
    evidence: [],
  };
  if (options.signal?.aborted)
    throw new SupervisorLaunchError(
      "Launch was cancelled before creating a supervisor",
      emptyCleanup,
    );
  const capability = supervisionCapability();
  if (!capability.available)
    throw new SupervisorLaunchError(capability.reason ?? "Supervisor unavailable", {
      ...emptyCleanup,
      status: "unconfirmed",
      reasons: [capability.reason ?? "Supervisor unavailable"],
    });
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") await windowsHelperExecutable();
  if (options.signal?.aborted)
    throw new SupervisorLaunchError("Launch cancelled before guardian creation", emptyCleanup);
  const directory = await realpath(options.directory);
  const bootstrap = bootstrapSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    nonce: randomUUID(),
    ownerEpoch: options.ownerEpoch,
    directory,
    lifetime: options.lifetime,
  });
  await publishImmutable(
    join(directory, "bootstrap.json"),
    Buffer.from(JSON.stringify(bootstrap)),
    "supervisor-bootstrap",
  );
  const nodeCommand = options.nodeCommand ?? (process.versions.bun ? "node" : process.execPath);
  const child = spawn(
    nodeCommand,
    [
      "--import",
      new URL("../../typescript.mjs", import.meta.url).href,
      fileURLToPath(new URL("./guardian.ts", import.meta.url)),
      directory,
    ],
    { detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
  );
  let guardianErrors = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    if (guardianErrors.length < 16_384) guardianErrors += chunk;
  });
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let handle: SupervisedProcess | undefined;
  try {
    const identity = await new Promise<SupervisorIdentity>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Guardian enrollment timed out")), 10_000);
      child.once("message", (message: unknown) => {
        clearTimeout(timeout);
        const parsed = z
          .strictObject({ kind: z.literal("ready"), identity: supervisorIdentitySchema })
          .safeParse(message);
        if (parsed.success) resolve(parsed.data.identity);
        else reject(new Error("Guardian enrollment is invalid"));
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(`Guardian exited before enrollment: ${guardianErrors.trim()}`));
      });
    });
    handle = await SupervisedProcess.connect(identity, { child, onEvent: options.onEvent });
    await options.onEnrolled(structuredClone(identity));
    if (options.signal?.aborted)
      throw new Error("Launch was cancelled before payload authorization");
    handle.bindAbort(options.signal);
    await handle.start({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
    });
    if (options.signal?.aborted)
      throw new Error("Launch was cancelled during payload authorization");
    return handle;
  } catch (cause) {
    let cleanup: CleanupReceipt;
    if (handle) cleanup = await handle.stop({ reason: "Partial launch cleanup" });
    else {
      // No start command was sent. This freshly spawned child cannot have a
      // payload; its live ChildProcess handle is sufficient for bootstrap cleanup.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
      const evidence = await retainEvidence(directory, {
        schemaVersion: 1,
        supervisor: bootstrap.id,
        phase: "bootstrap-stopped",
        payloadAuthorized: false,
      });
      cleanup = { ...emptyCleanup, identities: [`guardian:${bootstrap.id}`], evidence: [evidence] };
    }
    throw new SupervisorLaunchError(
      cause instanceof Error ? cause.message : String(cause),
      cleanup,
      { cause },
    );
  }
}
