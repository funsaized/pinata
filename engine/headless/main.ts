import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonSchema } from "../contracts/json-schema.ts";
import type { Terminal } from "@earendil-works/pi-tui";
import {
  canonicalJson,
  DomainError,
  exportSchemas,
  type AssignmentRef,
  type SurfaceReply,
  type WaitResult,
} from "../contracts/index.ts";
import { digestBytes } from "../storage/io.ts";
import { loadBootstrap } from "../definitions/typed.ts";
import { type RuntimeSource, surfaceError } from "../sources/runtime.ts";
import { openSavedSource } from "../sources/saved.ts";
import { parseArguments, requireArgument, usage, type CliArguments } from "./arguments.ts";
import { paletteSchema } from "../contracts/config.ts";

export type CliIO = {
  out(text: string): void;
  error(text: string): void;
  input(): Promise<string>;
  signal: AbortSignal;
  terminal?: Terminal;
};

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
function output(args: CliArguments, io: CliIO, value: unknown): void {
  io.out(`${args.flags.has("json") ? canonicalJson(value) : JSON.stringify(value, null, 2)}\n`);
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
  const source = await openSavedSource(directory);
  if (args.command === "view") {
    if (!(io.terminal || (process.stdin.isTTY && process.stdout.isTTY)))
      throw new DomainError(
        "invalid_input",
        "The viewer requires an interactive terminal; use status --json for structured output",
      );
    const { openViewer } = await import("../viewer/main.ts");
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
  switch (args.command) {
    case "query":
      call = {
        method: "query",
        input: await jsonFile(requireArgument(args, 1, "query file or -"), io),
      };
      break;
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
    default:
      throw new DomainError("invalid_input", `Unknown command ${args.command}`);
  }
  const reply = await source.request(call, io.signal);
  output(args, io, reply);
  return replyExitCode(reply);
}

async function discovery(args: CliArguments, io: CliIO): Promise<number> {
  if (args.command === "schema") {
    const name = args.positional[0];
    const schemas = exportSchemas(name);
    output(args, io, name ? schemas[name] : schemas);
    return 0;
  }
  if (args.command === "tools") {
    const { coordinatorTools } = await import("../pi/tools.ts");
    const { workerToolSchemas } = await import("../agent/tool-schemas.ts");
    output(args, io, [
      ...coordinatorTools.map((tool) => ({
        name: tool.name,
        scope: "coordinator",
        description: tool.description,
        input: jsonSchema(tool.schema),
        output: tool.output ?? "pinata.surface-reply.v1",
      })),
      ...Object.entries(workerToolSchemas).map(([name, tool]) => ({
        name,
        scope: "worker",
        description: tool.availability,
        input: jsonSchema(tool.input),
        output: tool.output,
      })),
    ]);
    return 0;
  }
  const { availableDefinitions, freezeSkills } = await import("../definitions/index.ts");
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const agentDir = args.options.get("agent-dir") ?? getAgentDir();
  const directories = args.definitions.length
    ? args.definitions.map((path) => resolve(path))
    : [
        fileURLToPath(new URL("../../agents", import.meta.url)),
        join(agentDir, "pinata", "agents"),
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
  if (action === "validate")
    for (const { definition, path } of definitions)
      await freezeSkills(definition.pinata.skills, {
        cwd: dirname(path),
        agentDir,
        artifacts: {
          put: async (bytes) => ({ digest: digestBytes(bytes), size: bytes.byteLength }),
        },
      });
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
