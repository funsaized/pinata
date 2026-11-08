import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  canonicalJson,
  identitySchema,
  recoveryRequestSchema,
  runtimeCommandSchema,
  runtimeQuerySchema,
  waitRequestSchema,
  type SurfaceReply,
} from "../contracts/index.ts";
import { type RuntimeSource, surfaceError } from "../sources/runtime.ts";
import { piParameters } from "./schema.ts";

type SourceProvider = (context: ExtensionContext) => Promise<RuntimeSource>;
type ToolOperation = {
  name: string;
  description: string;
  schema: z.ZodType;
  request(value: Record<string, unknown>, callId: string): unknown;
};

function commandTool(name: string, kind: string, description: string): ToolOperation {
  const command = runtimeCommandSchema.options.find((option) => option.shape.kind.value === kind);
  if (!command) throw new Error(`No canonical command schema for ${kind}`);
  return {
    name,
    description,
    schema: z.strictObject({
      ...Object.fromEntries(Object.entries(command.shape).filter(([key]) => key !== "kind")),
      requestId: identitySchema.optional(),
    }),
    request({ requestId, ...value }, callId) {
      return {
        method: "execute",
        input: { requestId: requestId ?? callId, command: { kind, ...value } },
      };
    },
  };
}

function queryTool(name: string, kind: string, description: string): ToolOperation {
  const query = runtimeQuerySchema.options.find((option) => option.shape.kind.value === kind);
  if (!query) throw new Error(`No canonical query schema for ${kind}`);
  return {
    name,
    description,
    schema: z.strictObject(
      Object.fromEntries(Object.entries(query.shape).filter(([key]) => key !== "kind")),
    ),
    request: (value) => ({ method: "query", input: { kind, ...value } }),
  };
}

const runCommands = runtimeCommandSchema.options.filter((option) =>
  ["create", "add", "follow_up", "continue", "background", "capacity"].includes(
    option.shape.kind.value,
  ),
);
export const coordinatorTools: readonly ToolOperation[] = [
  {
    name: "pinata_run",
    description:
      "Create or extend a run, queue a follow-up, explicitly continue stopped work, change optional capacity, or release a foreground wait. Workers use frozen definitions and grants; the coordinator decides testing and acceptance.",
    schema: z.strictObject({ requestId: identitySchema.optional(), command: z.union(runCommands) }),
    request: ({ requestId, command }, callId) => ({
      method: "execute",
      input: { requestId: requestId ?? callId, command },
    }),
  },
  commandTool(
    "pinata_steer",
    "steer",
    "Record instructions for an active or queued assignment. The receipt distinguishes durable acceptance from transport and consumption.",
  ),
  commandTool(
    "pinata_cancel",
    "cancel",
    "Cancel an assignment, worker or run. Partial output is retained; confirmed cleanup is reported separately.",
  ),
  commandTool(
    "pinata_integrate",
    "apply",
    "Explicitly apply a selected isolated snapshot with destination exclusion and conflict checks. This does not certify correctness. Inspect the application outcome using its operation ID.",
  ),
  commandTool(
    "pinata_rollback",
    "rollback",
    "Roll back one journaled application if the destination still matches. Later edits are preserved or reported as conflicts.",
  ),
  commandTool(
    "pinata_schedule",
    "schedule",
    "Manage a session-owned one-shot, interval or cron trigger. Occurrences are ordinary assignments; closed sessions cannot fire.",
  ),
  {
    name: "pinata_wait",
    description:
      "Wait for exact assignments or the next pending completion. Aborting this wait leaves workers running.",
    schema: waitRequestSchema,
    request: (value) => ({ method: "wait", input: value }),
  },
  {
    name: "pinata_status",
    description:
      "Inspect state, exact results, immutable conversation pages, schema discovery, receipts or an application outcome. Results are execution observations, not acceptance decisions.",
    schema: z.strictObject({ query: runtimeQuerySchema.default({ kind: "status" }) }),
    request: ({ query }) => ({ method: "query", input: query }),
  },
  queryTool(
    "pinata_agents",
    "definitions",
    "Discover validated agent definitions with their source paths and content digests.",
  ),
  queryTool(
    "pinata_changes",
    "changes",
    "Inspect a selected assignment's retained workspace snapshot, including failed or cancelled partial work.",
  ),
  {
    name: "pinata_recover",
    description:
      "Explicitly reattach original owned attempts or reconcile stopped work from retained evidence. Recovery never blindly relaunches an uncertain attempt.",
    schema: recoveryRequestSchema,
    request: (value) => ({ method: "recover", input: value }),
  },
];

export async function invokeCoordinatorTool(
  name: string,
  value: unknown,
  callId: string,
  source: RuntimeSource,
  signal?: AbortSignal,
): Promise<SurfaceReply> {
  try {
    const tool = coordinatorTools.find((candidate) => candidate.name === name);
    if (!tool)
      return {
        status: "error",
        error: { code: "invalid_input", message: `Unknown coordinator tool: ${name}` },
      };
    const parsed = z.record(z.string(), z.unknown()).parse(tool.schema.parse(value));
    return await source.request(tool.request(parsed, callId), signal);
  } catch (error) {
    return { status: "error", error: surfaceError(error) };
  }
}

export function registerCoordinatorTools(pi: ExtensionAPI, source: SourceProvider): void {
  for (const tool of coordinatorTools)
    pi.registerTool({
      name: tool.name,
      label: tool.name.replace(/^pinata_/, "Pinata "),
      description: tool.description,
      parameters: piParameters(tool.schema),
      executionMode: tool.name === "pinata_wait" ? "parallel" : "sequential",
      async execute(
        callId,
        value,
        signal,
        _update,
        context,
      ): Promise<AgentToolResult<SurfaceReply>> {
        if (!context) throw new Error("Coordinator tools require a host-bound Pi context");
        const reply = await invokeCoordinatorTool(
          tool.name,
          value,
          callId,
          await source(context),
          signal,
        );
        const rejected =
          reply.status === "error" ||
          (reply.response.method === "execute" && reply.response.result.status === "rejected");
        return {
          content: [{ type: "text", text: canonicalJson(reply) }],
          details: reply,
          ...(rejected ? { isError: true } : {}),
        };
      },
    });
}
