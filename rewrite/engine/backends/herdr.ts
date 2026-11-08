import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  assignmentRefSchema,
  BackendStartFailure,
  canonicalJson,
  digestValue,
  DomainError,
  identitySchema,
  type ArtifactPort,
  type ArtifactRef,
  type BackendCapabilities,
  type BackendHandle,
  type BackendIdentity,
  type BackendLaunch,
  type BackendObservation,
  type BackendPort,
  type BackendReattach,
  type CleanupReceipt,
  type ObservationSource,
} from "../contracts/index.ts";
import { ProcessBackend, type ProcessBackendOptions, type WorkerProcessHandle } from "./process.ts";
import { processStopSchema, readRecord, writeRecord } from "./process-transport.ts";
import {
  createHerdrControl,
  HerdrCommandError,
  insideHerdr,
  type HerdrCliOptions,
  type HerdrControl,
} from "./herdr-control.ts";

export const herdrPaneSchema = z.strictObject({
  workspaceId: identitySchema,
  paneId: identitySchema,
  terminalId: identitySchema,
});
export type HerdrPane = z.infer<typeof herdrPaneSchema>;
const savedPaneSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ref: assignmentRefSchema,
  attemptId: identitySchema,
  ownerEpoch: identitySchema,
  mode: z.literal("monitor"),
  pane: herdrPaneSchema,
});
type Observe = (observation: BackendObservation, source?: ObservationSource) => Promise<void>;
export type HerdrBackendOptions = ProcessBackendOptions & {
  herdr?: HerdrCliOptions;
  control?: (request: {
    cwd: string;
    directory: string;
    ownerEpoch: string;
    artifacts: ArtifactPort;
  }) => HerdrControl;
};

export function herdrCommandLine(
  argv: readonly string[],
  shell: "posix" | "fish" | "powershell",
): string {
  if (argv.some((arg) => arg.includes("\0"))) throw new Error("Shell arguments cannot contain NUL");
  const quote = (arg: string): string => {
    if (shell === "powershell") return `'${arg.replaceAll("'", "''")}'`;
    if (shell === "fish") return `'${arg.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    return `'${arg.replaceAll("'", "'\\''")}'`;
  };
  return `${shell === "powershell" ? "& " : ""}${argv.map(quote).join(" ")}`;
}

async function paneState(
  control: HerdrControl,
  pane: HerdrPane,
  signal: AbortSignal,
): Promise<"owned" | "missing" | "reused"> {
  try {
    const response = z
      .object({
        pane: z.object({ pane_id: z.string(), workspace_id: z.string(), terminal_id: z.string() }),
      })
      .parse(await control.request(["pane", "get", pane.paneId], signal));
    return response.pane.pane_id === pane.paneId &&
      response.pane.workspace_id === pane.workspaceId &&
      response.pane.terminal_id === pane.terminalId
      ? "owned"
      : "reused";
  } catch (error) {
    if (error instanceof HerdrCommandError && error.code === "pane_not_found") return "missing";
    throw error;
  }
}

async function closePane(control: HerdrControl, pane: HerdrPane): Promise<void> {
  const signal = AbortSignal.timeout(15_000);
  const state = await paneState(control, pane, signal);
  if (state === "missing") return;
  if (state !== "owned")
    throw new Error("Herdr pane identity changed; refusing to close its new occupant");
  // The user may have added other panes to our workspace. Close only the original
  // terminal, never the workspace or any neighboring user pane.
  await control.request(["pane", "close", pane.paneId], signal);
  if ((await paneState(control, pane, signal)) !== "missing")
    throw new Error("Herdr pane closure was not confirmed");
}

async function readyShell(
  control: HerdrControl,
  pane: HerdrPane,
  signal: AbortSignal,
): Promise<"posix" | "fish" | "powershell"> {
  const deadline = performance.now() + 10_000;
  while (true) {
    signal.throwIfAborted();
    if ((await paneState(control, pane, signal)) !== "owned")
      throw new Error("Herdr pane ownership changed before launch");
    const response = z
      .object({
        process_info: z.object({
          shell_pid: z.number().nullable(),
          foreground_process_group_id: z.number().nullable(),
          foreground_processes: z.array(z.object({ pid: z.number(), name: z.string() })),
        }),
      })
      .parse(await control.request(["pane", "process-info", "--pane", pane.paneId], signal));
    const info = response.process_info;
    const shell = info.foreground_processes.find((entry) => entry.pid === info.shell_pid);
    if (
      shell &&
      info.foreground_process_group_id === info.shell_pid &&
      info.foreground_processes.length === 1
    ) {
      const name = (shell.name.split(/[\\/]/).at(-1) ?? "")
        .replace(/^-/, "")
        .replace(/\.exe$/i, "")
        .toLowerCase();
      if (["sh", "bash", "zsh", "dash", "ksh", "ash"].includes(name)) return "posix";
      if (name === "fish") return "fish";
      if (name === "pwsh" || name === "powershell") return "powershell";
      throw new DomainError("unsupported", `Herdr pane shell ${name} is unsupported`);
    }
    if (performance.now() >= deadline) throw new Error("Herdr pane did not reach an idle shell");
    await delay(50);
  }
}

function observations(observe: Observe, paneEvidence: ArtifactRef): Observe {
  return (event, source) =>
    observe(
      event.kind === "enrolled"
        ? {
            ...event,
            identity: { ...event.identity, kind: "herdr-pi" },
            evidence: [...event.evidence, paneEvidence],
          }
        : event,
      source,
    );
}
function combineCleanup(
  ownerEpoch: string,
  receipts: CleanupReceipt[],
  extra: { identities: string[]; evidence: ArtifactRef[]; reasons: string[] },
): CleanupReceipt {
  const reasons = [
    ...receipts.flatMap((receipt) => (receipt.status === "unconfirmed" ? receipt.reasons : [])),
    ...extra.reasons,
  ];
  const identities = [...receipts.flatMap((receipt) => receipt.identities), ...extra.identities];
  const evidence = [...receipts.flatMap((receipt) => receipt.evidence), ...extra.evidence];
  return reasons.length
    ? { status: "unconfirmed", ownerEpoch, identities, evidence, reasons }
    : { status: "stopped", ownerEpoch, identities, evidence };
}

export class HerdrHandle implements BackendHandle {
  readonly identity: BackendIdentity;
  readonly done: BackendHandle["done"];
  readonly mode = "monitor" as const;
  readonly pane: HerdrPane;
  private readonly process: WorkerProcessHandle;
  private readonly control: HerdrControl;
  private readonly paneEvidence: ArtifactRef;
  private stopping?: ReturnType<BackendHandle["stop"]>;
  constructor(
    process: WorkerProcessHandle,
    control: HerdrControl,
    pane: HerdrPane,
    paneEvidence: ArtifactRef,
  ) {
    this.process = process;
    this.control = control;
    this.pane = pane;
    this.paneEvidence = paneEvidence;
    this.identity = { ...process.identity, kind: "herdr-pi" };
    this.done = process.done;
  }
  input: BackendHandle["input"] = (message) => this.process.input(message);
  checkpoint: BackendHandle["checkpoint"] = () => this.process.checkpoint();
  detach(): Promise<void> {
    return this.process.detach();
  }
  handoff(runtimeOwnerEpoch: string): Promise<void> {
    return this.process.handoff(runtimeOwnerEpoch);
  }
  stop(reason: string): ReturnType<BackendHandle["stop"]> {
    if (!this.stopping)
      this.stopping = (async () => {
        const stopped = await this.process.stop(reason);
        const reasons: string[] = [];
        try {
          await closePane(this.control, this.pane);
        } catch (error) {
          reasons.push(error instanceof Error ? error.message : String(error));
        }
        const cleanup = combineCleanup(
          this.identity.ownerEpoch,
          [stopped.cleanup, ...this.control.receipts()],
          {
            identities: [
              this.identity.id,
              `herdr:${this.pane.workspaceId}/${this.pane.paneId}/${this.pane.terminalId}`,
            ],
            evidence: [this.paneEvidence],
            reasons,
          },
        );
        return { ...stopped, cleanup };
      })();
    return this.stopping;
  }
}

export class HerdrBackend implements BackendPort {
  readonly kind = "herdr-pi" as const;
  readonly mode = "monitor" as const;
  readonly capabilities: BackendCapabilities;
  private readonly process: ProcessBackend;
  private readonly options: HerdrBackendOptions;
  constructor(options: HerdrBackendOptions) {
    this.options = options;
    this.process = new ProcessBackend(options);
    const available =
      this.process.capabilities.available &&
      Boolean(options.control || options.herdr?.session || insideHerdr());
    this.capabilities = {
      ...this.process.capabilities,
      available,
      ...(!available
        ? { reason: this.process.capabilities.reason ?? "Herdr requires a running local session" }
        : {}),
    };
  }
  private control(request: {
    cwd: string;
    directory: string;
    ownerEpoch: string;
    artifacts: ArtifactPort;
  }): HerdrControl {
    return (
      this.options.control?.(request) ??
      createHerdrControl({
        ...request,
        ...this.options.herdr,
        nodeCommand: this.options.nodeCommand,
      })
    );
  }
  async start(launch: BackendLaunch, observe: Observe, signal: AbortSignal): Promise<HerdrHandle> {
    signal.throwIfAborted();
    if (!this.capabilities.available)
      throw new DomainError("unsupported", this.capabilities.reason ?? "Herdr unavailable");
    const directory = join(launch.storeDirectory, "workers", digestValue(launch.attemptId));
    const control = this.control({
      cwd: launch.cwd,
      directory,
      ownerEpoch: launch.ownerEpoch,
      artifacts: launch.artifacts,
    });
    const label = `pinata-${launch.ref.worker}-${randomUUID()}`;
    const intent = await launch.artifacts.put(
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          kind: "herdr-create-intent",
          attemptId: launch.attemptId,
          label,
        }),
      ),
    );
    await writeRecord(join(directory, "herdr-intent.json"), { label, artifact: intent });
    let pane: HerdrPane | undefined;
    let handle: WorkerProcessHandle | undefined;
    let paneEvidence: ArtifactRef | undefined;
    try {
      const created = z
        .object({
          type: z.literal("workspace_created"),
          root_pane: z.object({
            workspace_id: z.string(),
            pane_id: z.string(),
            terminal_id: z.string(),
          }),
        })
        .parse(
          await control.request(
            ["workspace", "create", "--cwd", launch.cwd, "--label", label, "--no-focus"],
            signal,
          ),
        );
      pane = {
        workspaceId: created.root_pane.workspace_id,
        paneId: created.root_pane.pane_id,
        terminalId: created.root_pane.terminal_id,
      };
      const saved = savedPaneSchema.parse({
        schemaVersion: 1,
        ref: launch.ref,
        attemptId: launch.attemptId,
        ownerEpoch: launch.ownerEpoch,
        mode: "monitor",
        pane,
      });
      await writeRecord(join(directory, "herdr.json"), saved);
      paneEvidence = await launch.artifacts.put(Buffer.from(canonicalJson(saved)));
      const shell = await readyShell(control, pane, signal);
      handle = await this.process.start(
        { ...launch, worker: { ...launch.worker, backend: "process" } },
        observations(observe, paneEvidence),
        signal,
      );
      if ((await paneState(control, pane, signal)) !== "owned")
        throw new Error("Herdr pane identity changed before monitor launch");
      const command = herdrCommandLine(
        [
          this.options.nodeCommand ?? process.execPath,
          "--import",
          fileURLToPath(new URL("../typescript.mjs", import.meta.url)),
          fileURLToPath(new URL("./herdr-monitor.ts", import.meta.url)),
          directory,
        ],
        shell,
      );
      await control.request(["pane", "run", pane.paneId, command], signal);
      return new HerdrHandle(handle, control, pane, paneEvidence);
    } catch (error) {
      const receipts: CleanupReceipt[] = [];
      if (handle) receipts.push((await handle.stop("Herdr setup failed")).cleanup);
      else if (error instanceof BackendStartFailure) receipts.push(error.cleanup);
      const reasons: string[] = [];
      if (pane) {
        try {
          await closePane(control, pane);
        } catch (cleanupError) {
          reasons.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        }
      } else
        reasons.push(
          "Herdr pane creation was not acknowledged; retain its creation intent for reconciliation",
        );
      const cleanup = combineCleanup(launch.ownerEpoch, [...receipts, ...control.receipts()], {
        identities: pane
          ? [`herdr:${pane.workspaceId}/${pane.paneId}/${pane.terminalId}`]
          : [`herdr-create:${label}`],
        evidence: [intent, ...(paneEvidence ? [paneEvidence] : [])],
        reasons,
      });
      throw new BackendStartFailure(
        error instanceof Error ? error.message : String(error),
        {
          cleanup,
          artifacts: cleanup.evidence,
          ...(handle ? { identity: { ...handle.identity, kind: "herdr-pi" } } : {}),
        },
        { cause: error },
      );
    }
  }
  async reattach(
    request: BackendReattach,
    observe: Observe,
    signal: AbortSignal,
  ): Promise<HerdrHandle> {
    signal.throwIfAborted();
    const directory = join(request.storeDirectory, "workers", digestValue(request.attemptId));
    const saved = await readRecord(join(directory, "herdr.json"), savedPaneSchema);
    if (
      !saved ||
      saved.attemptId !== request.attemptId ||
      saved.ownerEpoch !== request.ownerEpoch ||
      canonicalJson(saved.ref) !== canonicalJson(request.ref) ||
      (request.identity && request.identity.kind !== "herdr-pi")
    )
      throw new DomainError("owner_unconfirmed", "Herdr pane enrollment differs from this attempt");
    const control = this.control({
      cwd: request.storeDirectory,
      directory,
      ownerEpoch: request.runtimeOwnerEpoch,
      artifacts: request.artifacts,
    });
    const state = await paneState(control, saved.pane, signal);
    const completed =
      state === "missing"
        ? await readRecord(join(directory, "backend-stop.json"), processStopSchema)
        : undefined;
    if (
      state === "reused" ||
      (state === "missing" && (completed?.cleanup.status !== "stopped" || !completed.outcome))
    )
      throw new DomainError("owner_unconfirmed", "Herdr pane identity is unavailable or changed");
    const paneEvidence = await request.artifacts.put(Buffer.from(canonicalJson(saved)));
    const handle = await this.process.reattach(
      {
        ...request,
        ...(request.identity ? { identity: { ...request.identity, kind: "process" } } : {}),
      },
      observations(observe, paneEvidence),
      signal,
    );
    return new HerdrHandle(handle, control, saved.pane, paneEvidence);
  }
}
