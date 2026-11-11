import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import type { Terminal } from "@earendil-works/pi-tui";
import {
  canonicalJson,
  DomainError,
  exportSchemas,
  grantsSchema,
  jobSchema,
  modelSchema,
  type AssignmentRef,
  type Job,
  type SurfaceReply,
  type WaitResult,
} from "../contracts/index.ts";
import { availableDefinitions } from "../definitions/index.ts";
import { loadBootstrap } from "../definitions/typed.ts";
import { type Host, type HostOptions } from "../host/index.ts";
import { AttachedSource } from "../sources/attached.ts";
import { startIpcServer } from "../ipc/server.ts";
import { bindRuntime, type RuntimeSource, surfaceError } from "../sources/runtime.ts";
import { openSavedSource } from "../sources/saved.ts";
import { planLegacyMigration } from "../migration/index.ts";
import { coordinatorTools } from "../pi/tools.ts";
import { workerToolSchemas } from "../agent/tool-schemas.ts";
import { parseArguments, requireArgument, usage, type CliArguments } from "./arguments.ts";
import { convertFile, importPlannedRun, validateMigrationDestination } from "./migration.ts";
import { openViewer } from "../viewer/main.ts";
import { paletteSchema } from "../contracts/config.ts";

export type CliIO = {
  out(text: string): void;
  error(text: string): void;
  input(): Promise<string>;
  signal: AbortSignal;
  terminal?: Terminal;
};
type HostFactory = (options: HostOptions) => Promise<Host>;

function waitCode(wait: WaitResult): number {
  if (wait.status === "aborted") return 3;
  if (
    wait.results.some(
      (result) =>
        result.execution.phase !== "ended" ||
        result.execution.cleanup !== "confirmed" ||
        ["failed", "interrupted"].includes(result.execution.reason),
    )
  )
    return 1;
  return wait.results.some(
    (result) => result.execution.phase === "ended" && result.execution.reason === "cancelled",
  )
    ? 3
    : 0;
}
export function replyExitCode(reply: SurfaceReply): number {
  if (reply.status === "error") return 2;
  const { response } = reply;
  if (response.method === "execute") return response.result.status === "accepted" ? 0 : 2;
  if (response.method === "wait") return waitCode(response.result);
  if (response.method === "query" && response.result.kind === "wait")
    return waitCode(response.result.wait);
  if (response.method === "query" && response.result.kind === "application")
    return response.result.operation?.status === "completed" ? 0 : 1;
  return 0;
}

async function jsonFile(path: string, io: CliIO): Promise<unknown> {
  return JSON.parse(path === "-" ? await io.input() : await readFile(resolve(path), "utf8"));
}
async function factory(args: CliArguments): Promise<HostFactory> {
  const path = args.options.get("factory");
  const module: unknown = path
    ? await import(pathToFileURL(resolve(path)).href)
    : await import("../host/index.ts");
  if (
    !module ||
    typeof module !== "object" ||
    !("openHost" in module) ||
    typeof module.openHost !== "function"
  )
    throw new DomainError("invalid_input", "Host factory must export openHost(options)");
  return module.openHost as HostFactory;
}
async function hostOptions(args: CliArguments, io: CliIO, job?: Job): Promise<HostOptions> {
  const config = args.options.get("config");
  const grants = args.options.get("grants");
  const model = args.options.get("model");
  const separator = model?.indexOf("/") ?? -1;
  if (model && (separator < 1 || separator === model.length - 1))
    throw new DomainError("invalid_input", "--model requires provider/id");
  return {
    workspace: args.options.get("workspace"),
    directory: args.options.get("directory"),
    run: args.options.get("run"),
    agentDir: args.options.get("agent-dir"),
    ...(grants ? { grants: grantsSchema.parse(await jsonFile(grants, io)) } : {}),
    ...(args.definitions.length
      ? { definitionDirectories: args.definitions.map((path) => resolve(path)) }
      : {}),
    ...(config || job?.config
      ? { config: { project: config ? await jsonFile(config, io) : undefined, run: job?.config } }
      : {}),
    ...(model
      ? {
          parentModel: modelSchema.parse({
            provider: model.slice(0, separator),
            id: model.slice(separator + 1),
            thinking: args.options.get("thinking") ?? "off",
          }),
        }
      : {}),
    ...(args.options.has("bootstrap")
      ? { bootstrapModule: resolve(args.options.get("bootstrap") ?? "") }
      : {}),
    onDiagnostic: (diagnostic) => io.error(`${canonicalJson(diagnostic)}\n`),
  };
}
function output(args: CliArguments, io: CliIO, value: unknown): void {
  io.out(`${args.flags.has("json") ? canonicalJson(value) : JSON.stringify(value, null, 2)}\n`);
}
async function stopped(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
}
async function openSource(
  args: CliArguments,
  directory: string,
  control: boolean,
): Promise<{ source: RuntimeSource; close(): void }> {
  if (!args.flags.has("saved")) {
    try {
      const client = await AttachedSource.connect({
        directory,
        role: control ? "control" : "viewer",
      });
      return { source: client, close: () => client.close() };
    } catch (error) {
      if (control)
        throw new DomainError(
          "context_unavailable",
          `Control needs a live owning runtime; start pinata serve --directory ${directory}. ${surfaceError(error).message}`,
        );
    }
  }
  if (control) throw new DomainError("capability_denied", "Saved sources cannot accept control");
  return { source: await openSavedSource(directory), close() {} };
}

async function runJob(args: CliArguments, io: CliIO, serve: boolean): Promise<number> {
  const input = args.positional[0];
  if (!serve && !input) throw new DomainError("invalid_input", "run requires a job file or -");
  const job = input ? jobSchema.parse(await jsonFile(input, io)) : undefined;
  const open = await factory(args);
  const host = await open(await hostOptions(args, io, job));
  let unsubscribe: (() => void) | undefined;
  let server: Awaited<ReturnType<typeof startIpcServer>> | undefined;
  let code = 0;
  try {
    if (args.flags.has("watch"))
      unsubscribe = await host.source.subscribe((event) =>
        output(args, io, { kind: "event", event }),
      );
    if (serve) {
      server = await startIpcServer({
        directory: host.directory,
        control: host.source,
        viewer: bindRuntime(host.runtime, { ...host.caller, kind: "viewer" }),
      });
      output(args, io, {
        kind: "ready",
        run: host.caller.run,
        directory: host.directory,
        protocol: server.link.protocol,
      });
    }
    if (job) {
      const receipt = await host.source.request({
        method: "execute",
        input: {
          requestId: args.options.get("request-id") ?? `cli/create/${host.caller.run}`,
          command: {
            kind: "create",
            workers: job.workers,
            ...(job.config ? { config: job.config } : {}),
          },
        },
      });
      output(args, io, receipt);
      code = replyExitCode(receipt);
      if (code) return code;
      if (!serve) {
        const wait = await host.source.request({ method: "wait", input: {} }, io.signal);
        output(args, io, wait);
        code = replyExitCode(wait);
      }
    }
    if (serve) await stopped(io.signal);
  } finally {
    unsubscribe?.();
    const closingServer = server?.close();
    const shutdown = await host.close(
      io.signal.aborted ? "CLI interrupted" : "Finite job completed",
    );
    await closingServer;
    if (shutdown.status !== "closed") code = 1;
    output(args, io, { kind: "closed", run: host.caller.run, directory: host.directory, shutdown });
  }
  return code;
}

function exactRef(args: CliArguments, source: RuntimeSource): AssignmentRef {
  const worker = requireArgument(args, 1, "worker");
  const assignment = args.positional[2]
    ? Number(args.positional[2])
    : source.snapshot().snapshot.latest[worker];
  if (!assignment)
    throw new DomainError("dependency_missing", `No assignment exists for ${worker}`);
  return { run: source.run, worker, assignment };
}
async function surfaceCommand(args: CliArguments, io: CliIO): Promise<number> {
  const directory = resolve(requireArgument(args, 0, "run directory"));
  const readOnly = [
    "view",
    "attach",
    "status",
    "logs",
    "query",
    "result",
    "conversation",
    "changes",
  ];
  const control =
    args.flags.has("control") || (!readOnly.includes(args.command) && args.command !== "request");
  const connection = await openSource(args, directory, control);
  const source = connection.source;
  let unsubscribe: (() => void) | undefined;
  try {
    const terminal = Boolean(io.terminal || (process.stdin.isTTY && process.stdout.isTTY));
    if (
      args.command === "view" ||
      (args.command === "attach" && terminal && !args.flags.has("json") && !args.flags.has("watch"))
    ) {
      if (!terminal)
        throw new DomainError(
          "invalid_input",
          "The viewer requires an interactive terminal; use status --json for structured output",
        );
      await openViewer({
        source,
        terminal: io.terminal,
        signal: io.signal,
        ui: args.options.has("palette")
          ? { palette: paletteSchema.parse(args.options.get("palette")) }
          : undefined,
      });
      return 0;
    }
    let call: unknown;
    const command = (value: unknown) => ({
      method: "execute",
      input: { requestId: args.options.get("request-id") ?? randomUUID(), command: value },
    });
    switch (args.command) {
      case "request":
        call = await jsonFile(requireArgument(args, 1, "request file or -"), io);
        break;
      case "execute":
        call = {
          method: "execute",
          input: await jsonFile(requireArgument(args, 1, "command envelope file or -"), io),
        };
        break;
      case "query":
        call = {
          method: "query",
          input: await jsonFile(requireArgument(args, 1, "query file or -"), io),
        };
        break;
      case "attach":
      case "status":
        call = { method: "query", input: { kind: "status" } };
        break;
      case "logs":
        call = {
          method: "query",
          input: { kind: "events", since: Number(args.options.get("since") ?? 0) },
        };
        break;
      case "result":
      case "conversation":
      case "changes":
        call = {
          method: "query",
          input: {
            kind: args.command,
            ref: exactRef(args, source),
            ...(args.options.has("cursor") ? { cursor: args.options.get("cursor") } : {}),
          },
        };
        break;
      case "wait":
        call = {
          method: "wait",
          input: {
            ...(args.positional.length > 1 ? { workers: args.positional.slice(1) } : {}),
            next: args.flags.has("next"),
          },
        };
        break;
      case "recover":
        call = { method: "recover", input: {} };
        break;
      case "background":
        call = command({ kind: "background" });
        break;
      case "steer":
      case "follow-up":
      case "continue":
        call = command({
          kind: args.command === "follow-up" ? "follow_up" : args.command,
          worker: requireArgument(args, 1, "worker"),
          messageId: args.options.get("request-id") ?? randomUUID(),
          text: requireArgument(args, 2, "message"),
        });
        break;
      case "cancel":
        call = command({
          kind: "cancel",
          scope: args.options.get("scope") ?? "run",
          ...(args.options.has("worker") ? { worker: args.options.get("worker") } : {}),
          ...(args.options.has("assignment")
            ? { assignment: Number(args.options.get("assignment")) }
            : {}),
        });
        break;
      case "apply":
        call = command({
          kind: "apply",
          ref: exactRef(args, source),
          destination: args.options.has("destination")
            ? resolve(args.options.get("destination") ?? "")
            : "",
        });
        break;
      case "rollback":
        call = command({
          kind: "rollback",
          operation: requireArgument(args, 1, "operation"),
          destination: args.options.has("destination")
            ? resolve(args.options.get("destination") ?? "")
            : "",
        });
        break;
      case "reconcile":
        call = command({
          kind: "reconcile",
          operation: requireArgument(args, 1, "operation"),
          owner: args.options.get("owner") ?? "",
        });
        break;
      default:
        throw new DomainError("invalid_input", `Unknown command ${args.command}`);
    }
    const reply = await source.request(call, io.signal);
    output(args, io, reply);
    let code = replyExitCode(reply);
    if (
      reply.status === "ok" &&
      reply.response.method === "execute" &&
      reply.response.result.status === "accepted" &&
      reply.response.result.operationId
    ) {
      const applied = await source.request(
        {
          method: "query",
          input: { kind: "application", operationId: reply.response.result.operationId },
        },
        io.signal,
      );
      output(args, io, applied);
      code = replyExitCode(applied);
    }
    if (args.flags.has("watch") && !code) {
      unsubscribe = await source.subscribe((event) => output(args, io, { kind: "event", event }));
      await stopped(io.signal);
    }
    return code;
  } finally {
    unsubscribe?.();
    connection.close();
  }
}

async function discovery(args: CliArguments, io: CliIO): Promise<number> {
  if (args.command === "schema") {
    const schemas = exportSchemas();
    const name = args.positional[0];
    if (name && !Object.hasOwn(schemas, name))
      throw new DomainError("invalid_input", `Unknown schema: ${name}`);
    output(args, io, name ? schemas[name] : schemas);
    return 0;
  }
  if (args.command === "tools") {
    output(args, io, [
      ...coordinatorTools.map((tool) => ({
        name: tool.name,
        scope: "coordinator",
        description: tool.description,
        input: z.toJSONSchema(tool.schema, { target: "draft-07", io: "input" }),
        output: tool.output ?? "pinata.surface-reply.v1",
      })),
      ...Object.entries(workerToolSchemas).map(([name, tool]) => ({
        name,
        scope: "worker",
        description: tool.availability,
        input: z.toJSONSchema(tool.input, { target: "draft-07", io: "input" }),
        output: tool.output,
      })),
    ]);
    return 0;
  }
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const directories = args.definitions.length
    ? args.definitions.map((path) => resolve(path))
    : [
        fileURLToPath(new URL("../../agents", import.meta.url)),
        join(args.options.get("agent-dir") ?? getAgentDir(), "pinata", "agents"),
        join(resolve(args.options.get("workspace") ?? process.cwd()), ".pi", "pinata", "agents"),
      ];
  const action = args.positional[0] ?? "list";
  if (!["list", "show", "validate"].includes(action))
    throw new DomainError("invalid_input", "agents accepts list, show or validate");
  const selected = args.options.get("bootstrap");
  const available = await availableDefinitions(
    directories,
    selected ? await loadBootstrap(selected) : undefined,
  );
  const name = action === "show" ? requireArgument(args, 1, "definition name") : undefined;
  const definitions = name
    ? available.filter((source) => source.definition.name === name)
    : available;
  if (!definitions.length && name)
    throw new DomainError("invalid_input", `No definition found for ${name}`, "agent");
  output(args, io, {
    kind: "definitions",
    definitions: definitions.map(({ definition, path, digest, outputSchema }) => ({
      definition,
      path,
      digest,
      ...(outputSchema ? { outputSchema } : {}),
    })),
  });
  return 0;
}

export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  let args: CliArguments | undefined;
  try {
    args = parseArguments(argv);
    switch (args.command) {
      case "help":
        io.out(`${usage}\n`);
        return 0;
      case "schema":
      case "tools":
      case "agents":
        return await discovery(args, io);
      case "run":
        return await runJob(args, io, false);
      case "serve":
        return await runJob(args, io, true);
      case "migrate": {
        const converted = await convertFile({
          path: requireArgument(args, 0, "input"),
          kind: args.options.get("kind"),
          output: args.options.get("output"),
          run: args.options.get("run"),
        });
        output(args, io, converted);
        return 0;
      }
      case "migrate-run": {
        const plan = await planLegacyMigration({
          source: requireArgument(args, 0, "source directory"),
          workspace: args.options.get("workspace") ?? process.cwd(),
          run: args.options.get("run") ?? randomUUID(),
        });
        if (args.options.has("output")) {
          await validateMigrationDestination(plan, args.options.get("output") ?? "");
          await writeFile(
            resolve(args.options.get("output") ?? ""),
            `${canonicalJson(plan.manifest)}\n`,
            { flag: "wx", mode: 0o600 },
          );
        }
        output(args, io, {
          kind: "migration-plan",
          manifest: plan.manifest,
          blockers: plan.blockers,
        });
        if (!args.flags.has("import")) return plan.blockers.length ? 2 : 0;
        if (plan.blockers.length)
          throw new DomainError("conflict", "Resolve migration blockers before import");
        if (!args.options.has("directory"))
          throw new DomainError("invalid_input", "--import requires a new --directory");
        await validateMigrationDestination(plan, args.options.get("directory") ?? "");
        const open = await factory(args);
        const host = await open({
          ...(await hostOptions(args, io)),
          run: plan.manifest.destination.run,
          workspace: plan.manifest.destination.workspace,
          origin: {
            run: plan.manifest.source.run,
            store: plan.manifest.source.directory,
            manifestDigest: plan.manifest.source.manifest.digest,
          },
        });
        try {
          const receipt = await importPlannedRun(
            plan,
            host,
            args.options.get("request-id") ?? `migration/${plan.manifest.source.manifest.digest}`,
          );
          output(args, io, { kind: "migration-import", receipt, directory: host.directory });
          return receipt.status === "accepted" ? 0 : 2;
        } finally {
          await host.close("Historical import finished; no work was launched");
        }
      }
      default:
        return await surfaceCommand(args, io);
    }
  } catch (error) {
    const detail =
      error instanceof SyntaxError
        ? { code: "invalid_input", message: "Input is not valid JSON" }
        : surfaceError(error);
    if (args?.flags.has("json")) output(args, io, { status: "error", error: detail });
    else io.error(`pinata: ${detail.message}\n`);
    return 2;
  }
}
