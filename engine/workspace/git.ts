import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  digestValue,
  type ArtifactPort,
  type ArtifactRef,
  type CleanupReceipt,
} from "../contracts/index.ts";
import {
  launchSupervised,
  reconcileSupervisor,
  stopSupervisor,
  SupervisorLaunchError,
  type SupervisedProcess,
} from "../backends/supervision/index.ts";
import { bootstrapSchema, supervisorIdentitySchema } from "../backends/supervision/contracts.ts";
import { readEvidence } from "../backends/supervision/evidence.ts";
import { digestBytes, isMissing, publishImmutable } from "../storage/io.ts";
import { gitCommandResultSchema, gitRequestSchema } from "./git-protocol.ts";

export type GitReply = {
  code: number | null;
  signal?: string | null;
  stdout: Buffer;
  stderr: string;
  evidence?: ArtifactRef[];
};
export class GitFailure extends Error {
  readonly cleanup: CleanupReceipt;
  readonly reply?: GitReply;
  constructor(message: string, cleanup: CleanupReceipt, reply?: GitReply, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitFailure";
    this.cleanup = cleanup;
    this.reply = reply;
  }
}

// One operation-scoped guardian owns the service and every Git helper. Commands
// serialize locally; independent workspace operations use separate scopes.
// Call close() before reporting preparation/capture/application cleanup.
export class GitCommands {
  readonly directory: string;
  readonly ownerEpoch: string;
  readonly artifacts: ArtifactPort;
  readonly evidence: ArtifactRef[] = [];
  private readonly nodeCommand?: string;
  private handle?: Promise<SupervisedProcess>;
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<CleanupReceipt>;
  private buffer = "";
  private readonly pending = new Map<string, () => void>();

  constructor(options: {
    directory: string;
    ownerEpoch: string;
    artifacts: ArtifactPort;
    nodeCommand?: string;
  }) {
    this.directory = join(options.directory, randomUUID());
    this.ownerEpoch = options.ownerEpoch;
    this.artifacts = options.artifacts;
    this.nodeCommand = options.nodeCommand;
  }

  private start(): Promise<SupervisedProcess> {
    this.handle ??= (async () => {
      for (const name of ["requests", "results", "empty-hooks"])
        await mkdir(join(this.directory, name), { recursive: true, mode: 0o700 });
      await publishImmutable(join(this.directory, "empty.config"), Buffer.alloc(0), "git-config");
      return launchSupervised({
        directory: join(this.directory, "supervisor"),
        command: this.nodeCommand ?? (process.versions.bun ? "node" : process.execPath),
        args: [
          "--import",
          new URL("../typescript.mjs", import.meta.url).href,
          fileURLToPath(new URL("./git-worker.ts", import.meta.url)),
          this.directory,
        ],
        cwd: this.directory,
        ownerEpoch: this.ownerEpoch,
        lifetime: "attached",
        nodeCommand: this.nodeCommand,
        onEnrolled: async (identity) => {
          this.evidence.push(
            await this.artifacts.put(
              Buffer.from(canonicalJson({ identity, kind: "git-command-scope" })),
            ),
          );
        },
        onEvent: (event) => {
          if (event.kind !== "output" || event.stream !== "stdout") return;
          this.buffer += Buffer.from(event.data, "base64").toString("utf8");
          let index: number;
          while ((index = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);
            const id: unknown = JSON.parse(line);
            if (typeof id === "string") this.pending.get(id)?.();
          }
        },
      });
    })();
    return this.handle;
  }

  run(
    cwd: string,
    args: readonly string[],
    options: {
      input?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
      allowFailure?: boolean;
    } = {},
  ): Promise<GitReply> {
    const operation = this.queue.then(() => this.command(cwd, args, options));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  // Host-only setup execution shares this operation's guardian. The persisted
  // request contains environment names; values are selected inside the helper.
  program(
    cwd: string,
    executable: string,
    args: readonly string[],
    options: {
      requestId: string;
      passEnv: readonly string[];
      sourceRoot: string;
      signal?: AbortSignal;
      allowFailure?: boolean;
    },
  ): Promise<GitReply> {
    const operation = this.queue.then(() =>
      this.command(cwd, args, options, {
        executable,
        passEnv: [...options.passEnv],
        sourceRoot: options.sourceRoot,
      }),
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async command(
    cwd: string,
    args: readonly string[],
    options: {
      input?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
      allowFailure?: boolean;
      requestId?: string;
    },
    program?: { executable: string; passEnv: string[]; sourceRoot: string },
  ): Promise<GitReply> {
    options.signal?.throwIfAborted();
    if (this.closing) throw new Error("Git command scope is closed");
    let reply: GitReply | undefined;
    const id = options.requestId ?? randomUUID();
    const aborted = (): void => {
      void this.close().catch(() => undefined);
    };
    options.signal?.addEventListener("abort", aborted, { once: true });
    try {
      const handle = await this.start();
      options.signal?.throwIfAborted();
      const request = gitRequestSchema.parse({
        id,
        cwd,
        ...(program ? { program } : {}),
        args: program
          ? [...args]
          : [
              "-C",
              cwd,
              "-c",
              "core.fsmonitor=false",
              "-c",
              `core.hooksPath=${join(this.directory, "empty-hooks")}`,
              "-c",
              "core.autocrlf=false",
              "-c",
              "core.longpaths=true",
              "-c",
              "protocol.allow=never",
              "--no-pager",
              ...args,
            ],
        env: options.env ?? {},
        ...(options.input !== undefined ? { input: options.input } : {}),
      });
      await publishImmutable(
        join(this.directory, "requests", `${id}.json`),
        Buffer.from(canonicalJson(request)),
        "git-request",
      );
      const completed = new Promise<void>((resolve) => {
        this.pending.set(id, resolve);
      });
      await handle.writeInput(JSON.stringify(id) + "\n");
      await Promise.race([
        completed,
        handle.closed.then(() => {
          throw new Error("Git guardian disconnected before command completion");
        }),
        handle.exit.then(() => {
          throw new Error("Git command service exited before command completion");
        }),
      ]);
      const resultDirectory = join(this.directory, "results", id);
      const result = gitCommandResultSchema.parse(
        JSON.parse(await readFile(join(resultDirectory, "result.json"), "utf8")),
      );
      if (result.id !== id || result.requestDigest !== digestValue(request))
        throw new Error("Git result belongs to a different immutable request");
      const [stdout, stderr] = await Promise.all([
        readFile(join(resultDirectory, "stdout.bin")),
        readFile(join(resultDirectory, "stderr.bin")),
      ]);
      if (digestBytes(stdout) !== result.stdout || digestBytes(stderr) !== result.stderr)
        throw new Error("Retained Git output changed after publication");
      reply = {
        code: result.code,
        ...(result.signal ? { signal: result.signal } : {}),
        stdout,
        stderr: stderr.toString("utf8"),
        ...(program
          ? {
              evidence: [
                await this.artifacts.put(Buffer.from(canonicalJson({ request, result }))),
                await this.artifacts.put(stdout),
                await this.artifacts.put(stderr),
              ],
            }
          : {}),
      };
      options.signal?.throwIfAborted();
      if (result.error) throw new Error(result.error);
      if (reply.code !== 0 && !options.allowFailure)
        throw new Error(
          `${program?.executable ?? "git"} ${args[0]} failed (${reply.code}): ${reply.stderr.trim()}`,
        );
      return reply;
    } catch (cause) {
      const cleanup = await this.close();
      throw new GitFailure(cause instanceof Error ? cause.message : String(cause), cleanup, reply, {
        cause,
      });
    } finally {
      this.pending.delete(id);
      options.signal?.removeEventListener("abort", aborted);
    }
  }

  close(): Promise<CleanupReceipt> {
    this.closing ??= (async () => {
      let cleanup: CleanupReceipt;
      if (!this.handle)
        return {
          status: "stopped",
          ownerEpoch: this.ownerEpoch,
          identities: [],
          evidence: this.evidence,
        };
      try {
        cleanup = await (
          await this.handle
        ).stop({ reason: "Git operation scope finished", graceMs: 0 });
      } catch (error) {
        cleanup =
          error instanceof SupervisorLaunchError
            ? error.cleanup
            : {
                status: "unconfirmed",
                ownerEpoch: this.ownerEpoch,
                identities: [],
                evidence: [],
                reasons: [error instanceof Error ? error.message : String(error)],
              };
      }
      try {
        const evidence = await Promise.all(
          cleanup.evidence.map(async (ref) =>
            this.artifacts.put(await readEvidence(join(this.directory, "supervisor"), ref)),
          ),
        );
        this.evidence.push(...evidence);
        return { ...cleanup, evidence: [...this.evidence] };
      } catch (error) {
        return {
          ...cleanup,
          status: "unconfirmed",
          evidence: [...this.evidence],
          reasons: [error instanceof Error ? error.message : String(error)],
        };
      }
    })();
    return this.closing;
  }
}

export function gitLine(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/\r?\n$/, "");
}
export function nulPaths(bytes: Buffer): string[] {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw new Error("Git path output has an incomplete record");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes))
    throw new Error("Git paths contain unsupported non-UTF8 bytes");
  return text.slice(0, -1).split("\0");
}

// Called only after the operation owner was explicitly reconciled. Missing
// bootstrap means spawn was never authorized; every later stage needs the
// guardian's retained identity and positive cleanup evidence.
export async function recoverGitCleanup(
  directory: string,
  ownerEpoch: string,
  artifacts: ArtifactPort,
): Promise<CleanupReceipt> {
  const supervisor = join(directory, "supervisor");
  try {
    let bootstrap;
    try {
      bootstrap = bootstrapSchema.parse(
        JSON.parse(await readFile(join(supervisor, "bootstrap.json"), "utf8")),
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      const remaining = await readdir(supervisor).catch((cause: unknown) => {
        if (isMissing(cause)) return [];
        throw cause;
      });
      if (remaining.some((name) => !name.startsWith(".unaccepted-")))
        throw new Error("Git bootstrap is missing while other supervisor evidence remains");
      const evidence = await artifacts.put(
        Buffer.from(
          canonicalJson({
            schemaVersion: 1,
            kind: "git-no-supervisor-authorized",
            directory,
            ownerEpoch,
          }),
        ),
      );
      return { status: "stopped", ownerEpoch, identities: [], evidence: [evidence] };
    }
    const identity = supervisorIdentitySchema.parse(
      JSON.parse(await readFile(join(supervisor, "identity.json"), "utf8")),
    );
    if (
      identity.ownerEpoch !== ownerEpoch ||
      identity.directory !== supervisor ||
      bootstrap.id !== identity.id ||
      bootstrap.nonce !== identity.nonce ||
      bootstrap.ownerEpoch !== ownerEpoch
    )
      throw new Error("Git supervisor identity does not match the retained helper scope");
    let cleanup = await stopSupervisor(identity, { reason: "Explicit Git helper recovery" });
    if (cleanup.status !== "stopped")
      cleanup = await reconcileSupervisor(identity, { reason: "Explicit Git helper recovery" });
    const evidence = await Promise.all(
      cleanup.evidence.map(async (ref) => artifacts.put(await readEvidence(supervisor, ref))),
    );
    return { ...cleanup, evidence };
  } catch (error) {
    return {
      status: "unconfirmed",
      ownerEpoch,
      identities: [],
      evidence: [],
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}
