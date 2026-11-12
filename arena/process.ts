import { randomUUID } from "node:crypto";
import {
  launchSupervised,
  SupervisorLaunchError,
  type SupervisorEvent,
  type SupervisorIdentity,
  type SupervisedProcess,
} from "../engine/backends/supervision/index.ts";
import type { CleanupReceipt } from "../engine/contracts/backend.ts";
import type { Artifact, Limits } from "./contracts.ts";
import { EvidenceStore } from "./evidence.ts";

export type ProcessResult = {
  exit: { code: number | null; signal: string | null };
  state: "completed" | "timed_out" | "cancelled" | "failed";
  stdout: Buffer;
  stderr: Buffer;
  cleanup: CleanupReceipt;
  evidence: Artifact[];
  elapsedMs: number;
  failure?: string;
};
export async function runProcess(options: {
  directory: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  limits: Limits;
  store: EvidenceStore;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEnrolled?: (identity: SupervisorIdentity) => Promise<void>;
}): Promise<ProcessResult> {
  const started = performance.now();
  const controller = new AbortController();
  let state: ProcessResult["state"] = "completed";
  let total = 0;
  const records: unknown[] = [];
  const enrollment: Artifact[] = [];
  const ownerEpoch = randomUUID();
  const abort = () => {
    state = "cancelled";
    controller.abort();
  };
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    state = "timed_out";
    controller.abort();
  }, options.timeoutMs ?? options.limits.timeoutMs);
  const observe = (event: SupervisorEvent) => {
    records.push({
      receiptNs: process.hrtime.bigint().toString(),
      receivedAt: new Date().toISOString(),
      event,
    });
    if (event.kind === "output") {
      total += event.length;
      if (total > options.limits.maxLogBytes) {
        state = "failed";
        controller.abort();
      }
    }
  };
  let handle: SupervisedProcess | undefined;
  try {
    handle = await launchSupervised({
      directory: options.directory,
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      ownerEpoch,
      lifetime: "attached",
      signal: controller.signal,
      onEnrolled: async (identity) => {
        enrollment.push(
          await options.store.json({
            schemaVersion: 1,
            kind: "enrollment",
            identity,
            command: options.command,
            args: options.args,
            cwd: options.cwd,
          }),
        );
        await options.onEnrolled?.(identity);
      },
      onEvent: observe,
    });
    const exit = await handle.exit;
    const cleanup = await handle.stop({
      reason: state === "completed" ? "Experiment process exited" : `Experiment ${state}`,
      graceMs: Math.min(options.limits.cleanupMs, 30000),
      confirmationMs: Math.min(options.limits.cleanupMs, 30000),
    });
    let drained = false;
    try {
      await handle.outputDrained;
      drained = true;
    } catch {
      if (state === "completed") state = "failed";
    }
    const read = async (stream: "stdout" | "stderr"): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < options.limits.maxLogBytes) {
        if (!handle) throw new Error("Supervisor unavailable");
        const part = await handle.readOutput({
          stream,
          offset,
          maxBytes: Math.min(65536, options.limits.maxLogBytes - offset),
        });
        if (!part.bytes.length) break;
        chunks.push(part.bytes);
        offset = part.nextOffset;
      }
      return Buffer.concat(chunks);
    };
    const stdout = await read("stdout");
    const stderr = await read("stderr");
    if (
      (!drained || cleanup.status !== "stopped" || handle.diagnostics().length) &&
      state === "completed"
    )
      state = "failed";
    const evidence = [
      ...enrollment,
      await options.store.json({
        schemaVersion: 1,
        identity: handle.identity,
        exit,
        cleanup,
        diagnostics: handle.diagnostics(),
        elapsedMs: performance.now() - started,
      }),
      await options.store.json(records),
      await options.store.put(stdout),
      await options.store.put(stderr),
    ];
    return {
      exit,
      state,
      stdout,
      stderr,
      cleanup,
      evidence,
      elapsedMs: performance.now() - started,
    };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    const cleanup = handle
      ? await handle.stop({
          reason: "Experiment failed",
          graceMs: Math.min(options.limits.cleanupMs, 30000),
          confirmationMs: Math.min(options.limits.cleanupMs, 30000),
        })
      : error instanceof SupervisorLaunchError
        ? error.cleanup
        : {
            status: "unconfirmed" as const,
            ownerEpoch,
            identities: [],
            evidence: [],
            reasons: [failure],
          };
    const evidence = [
      ...enrollment,
      await options.store.json({ schemaVersion: 1, failure, cleanup, records }),
    ];
    return {
      state: state === "completed" ? "failed" : state,
      exit: { code: null, signal: null },
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(failure),
      cleanup,
      evidence,
      elapsedMs: performance.now() - started,
      failure,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (handle)
      await handle.stop({
        reason: "Experiment scope closed",
        graceMs: Math.min(options.limits.cleanupMs, 30000),
        confirmationMs: Math.min(options.limits.cleanupMs, 30000),
      });
  }
}
