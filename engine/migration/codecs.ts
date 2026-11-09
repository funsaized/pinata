import { createHash } from "node:crypto";
import { z } from "zod";
import {
  accessSchema,
  backendSchema,
  digestSchema,
  idSchema,
  modelSchema,
  revisionSchema,
  textSchema,
  workspaceSchema,
} from "../contracts/common.ts";

const oldRef = z.strictObject({ worker: idSchema, assignment: revisionSchema.positive() });
const check = z.strictObject({
  id: textSchema,
  argv: z.array(textSchema),
  timeoutMs: revisionSchema.positive().optional(),
});
export const legacyTaskSchema = z.strictObject({
  id: idSchema,
  agent: idSchema.optional(),
  role: idSchema.optional(),
  definition: digestSchema.optional(),
  task: textSchema,
  acceptance: z.array(z.string()).optional(),
  instructions: z.array(z.string()).optional(),
  context: z.array(z.string()).optional(),
  after: z.array(z.union([idSchema, oldRef])).optional(),
  inputs: z.array(oldRef).optional(),
  workspace: workspaceSchema.optional(),
  reviewOf: idSchema.optional(),
  reviewBase: textSchema.optional(),
  reviewPr: revisionSchema.positive().optional(),
  model: modelSchema.optional(),
  backend: backendSchema.optional(),
  ownership: z.array(textSchema).optional(),
  checks: z.array(check).optional(),
  evidenceChecks: z.array(check).optional(),
  noChecksReason: z.string().optional(),
  limits: z.json().optional(),
  deadlineAt: revisionSchema.optional(),
});
export type LegacyTask = z.infer<typeof legacyTaskSchema>;
export const legacyDefinitionSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  name: idSchema,
  description: textSchema,
  access: accessSchema.optional(),
  workspace: z.enum(["shared", "worktree", "live-readonly"]),
  tools: z.array(textSchema),
  prompt: z.string(),
  output: z.strictObject({ require: z.array(z.enum(["brief", "sources"])) }).optional(),
  model: modelSchema.optional(),
  fallbacks: z.array(modelSchema).max(5).optional(),
  source: textSchema.optional(),
  digest: digestSchema.optional(),
});
export type LegacyDefinition = z.infer<typeof legacyDefinitionSchema>;
const provider = z.strictObject({ extension: textSchema, tools: z.array(textSchema) });
export const legacyConfigSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  workspace: workspaceSchema.optional(),
  models: z.record(z.string(), modelSchema).optional(),
  fallbacks: z.record(z.string(), z.array(modelSchema).max(5)).optional(),
  toolProviders: z.record(z.string(), provider).optional(),
  passEnv: z.array(textSchema).optional(),
  webExtension: textSchema.optional(),
  setup: z.union([z.literal(false), textSchema]).optional(),
  worktreeRoot: textSchema.optional(),
  codemode: z.boolean().optional(),
  includeUncommitted: z.boolean().optional(),
  mode: z.enum(["lean", "observe"]).optional(),
  backend: backendSchema.optional(),
  limits: z.json().optional(),
  reviewPolicy: z.json().optional(),
  deadlineAt: z.json().optional(),
  workspaceReuse: z.json().optional(),
  pi: z.json().optional(),
  herdr: z.json().optional(),
  session: z.json().optional(),
});
export const legacyJobSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  run: textSchema.optional(),
  cwd: textSchema.optional(),
  approval: z.string().optional(),
  allowWrites: z.boolean().optional(),
  workspace: workspaceSchema.optional(),
  instructions: z.array(z.string()).optional(),
  integration: z.enum(["manual", "apply", "on-success"]).optional(),
  tasks: z.array(legacyTaskSchema).min(1),
  config: legacyConfigSchema.optional(),
  limits: z.json().optional(),
  deadlineAt: z.json().optional(),
  reviewPolicy: z.json().optional(),
  integratedChecks: z.array(check).optional(),
  noIntegratedChecksReason: z.string().optional(),
});
export const legacyRunSchema = z.strictObject({
  schemaVersion: z.literal(3),
  id: textSchema,
  root: textSchema,
  store: textSchema.optional(),
  head: textSchema,
  branch: textSchema.optional(),
  integration: z.enum(["manual", "apply", "on-success"]).optional(),
  tasks: z.array(legacyTaskSchema),
  definitions: z.record(digestSchema, legacyDefinitionSchema).optional(),
  allowWrites: z.boolean(),
  passEnv: z.array(textSchema),
  resume: z
    .strictObject({
      mode: z.enum(["lean", "observe"]),
      data: z.record(z.string(), z.json()),
      survive: z.boolean(),
      background: z.boolean(),
      owner: z
        .strictObject({
          pid: revisionSchema.positive(),
          started: textSchema,
          host: textSchema.optional(),
        })
        .nullable(),
    })
    .optional(),
});
export type LegacyRun = z.infer<typeof legacyRunSchema>;

export function parseLegacyRun(input: unknown): LegacyRun {
  const run = legacyRunSchema.parse(input);
  if (new Set(run.tasks.map((task) => task.id)).size !== run.tasks.length)
    throw new Error("Legacy run repeats a worker identity");
  for (const [key, definition] of Object.entries(run.definitions ?? {})) {
    if (
      definition.schemaVersion !== 2 ||
      !definition.access ||
      !definition.source ||
      definition.digest !== key
    )
      throw new Error("Legacy definition snapshot lacks exact provenance");
    const encoded = {
      schemaVersion: 2,
      access: definition.access,
      name: definition.name,
      description: definition.description,
      workspace: definition.workspace,
      tools: definition.tools,
      prompt: definition.prompt,
      output: definition.output ?? { require: [] },
      ...(definition.model ? { model: definition.model } : {}),
      ...(definition.fallbacks ? { fallbacks: definition.fallbacks } : {}),
      source: definition.source,
    };
    if (createHash("sha256").update(JSON.stringify(encoded)).digest("hex") !== key)
      throw new Error("Legacy definition snapshot digest changed");
  }
  for (const task of run.tasks)
    if (task.definition && !Object.hasOwn(run.definitions ?? {}, task.definition))
      throw new Error("Legacy task references a missing definition snapshot");
  return run;
}

const usage = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  cost: z.number().nonnegative(),
});
const envelope = {
  v: z.union([z.literal(1), z.literal(2)]),
  seq: revisionSchema,
  run: textSchema,
  agent: idSchema.optional(),
  assignment: revisionSchema.positive().optional(),
  at: z.number().nonnegative(),
  source: z.strictObject({ id: textSchema, record: revisionSchema.positive() }).optional(),
};
const event = <T extends z.ZodRawShape>(fields: T) => z.strictObject({ ...envelope, ...fields });
export const legacyEventSchema = z.discriminatedUnion("t", [
  event({
    t: z.literal("run_started"),
    tasks: z.array(legacyTaskSchema),
    mode: z.enum(["lean", "observe"]),
    cwd: textSchema.optional(),
    store: textSchema.optional(),
    definitions: z.record(digestSchema, legacyDefinitionSchema).optional(),
    deadlineAt: revisionSchema.positive().optional(),
    reviewPolicy: z.enum(["optional", "required"]).optional(),
  }),
  event({
    t: z.literal("agent_queued"),
    task: legacyTaskSchema.optional(),
    repair: z.boolean().optional(),
    dependencies: z.array(oldRef).optional(),
    message: textSchema.optional(),
  }),
  event({
    t: z.literal("agent_started"),
    backend: z.union([backendSchema, z.literal("fake")]),
    model: modelSchema,
    workspace: z.strictObject({ kind: z.enum(["live", "worktree"]), path: textSchema }),
  }),
  event({ t: z.literal("turn_start"), turn: revisionSchema }),
  event({ t: z.literal("text_delta"), delta: z.string() }),
  event({ t: z.literal("thinking_delta"), delta: z.string() }),
  event({
    t: z.literal("message_end"),
    role: z.enum(["assistant", "user", "toolResult"]),
    usage: usage.optional(),
    stopReason: z.string().optional(),
    error: z.string().optional(),
  }),
  event({ t: z.literal("tool_start"), call: textSchema, name: textSchema, args: z.string() }),
  event({ t: z.literal("tool_update"), call: textSchema, preview: z.string() }),
  event({
    t: z.literal("tool_end"),
    call: textSchema,
    ok: z.boolean(),
    preview: z.string(),
    ms: z.number().nonnegative(),
  }),
  event({
    t: z.literal("steer"),
    by: z.enum(["user", "parent"]),
    text: z.string(),
    as: z.enum(["steer", "followUp"]),
  }),
  event({ t: z.literal("retry"), attempt: revisionSchema, reason: z.string() }),
  event({ t: z.literal("check_start"), check: textSchema }),
  event({
    t: z.literal("check_end"),
    check: textSchema,
    passed: z.boolean(),
    ms: z.number().nonnegative(),
  }),
  event({ t: z.literal("checkout_changed") }),
  event({
    t: z.literal("usage"),
    usage,
    turns: revisionSchema.optional(),
    toolCalls: revisionSchema.optional(),
  }),
  event({
    t: z.literal("agent_settled"),
    status: z.enum(["succeeded", "failed", "rejected", "blocked", "cancelled", "uncertain"]),
    summary: z.string(),
    reason: z.string().optional(),
    usage,
    turns: revisionSchema,
    toolCalls: revisionSchema,
  }),
  event({
    t: z.literal("run_settled"),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    usage,
    stopped: z.boolean().optional(),
  }),
  event({
    t: z.literal("run_resumed"),
    reason: z.string(),
    deadlineAt: revisionSchema.positive().optional(),
  }),
  event({
    t: z.literal("input_recorded"),
    message: textSchema,
    target: oldRef,
    kind: z.enum(["steer", "followUp"]),
    payload: z.string(),
  }),
  event({
    t: z.literal("input_dispatched"),
    message: textSchema,
    disposition: z.enum(["queued", "handled", "uncertain"]),
  }),
  event({ t: z.literal("input_consumed"), message: textSchema, checkpoint: textSchema }),
  event({
    t: z.literal("telemetry"),
    sample: z.strictObject({
      rssMB: z.number(),
      heapUsedMB: z.number(),
      elu: z.number(),
      lateMs: z.number(),
      processes: z
        .array(
          z.strictObject({
            agent: idSchema,
            pid: revisionSchema.positive(),
            rssMB: z.number().nullable(),
          }),
        )
        .optional(),
    }),
  }),
]);
export type LegacyEvent = z.infer<typeof legacyEventSchema>;
export function parseLegacyEvents(bytes: Uint8Array, run: string): LegacyEvent[] {
  const text = Buffer.from(bytes).toString("utf8");
  if (text && !text.endsWith("\n"))
    throw new Error(
      "Legacy event log has an incomplete final record; inspect it with the matching runtime",
    );
  const events: LegacyEvent[] = [];
  let sequence = -1;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const event = legacyEventSchema.parse(JSON.parse(line));
    if (event.run !== run || event.seq <= sequence)
      throw new Error("Legacy event identity or ordering is inconsistent");
    events.push(event);
    sequence = event.seq;
  }
  return events;
}
