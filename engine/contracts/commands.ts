import { z } from "zod";
import { agentColorSchema } from "./definition.ts";
import {
  accessSchema,
  artifactRefSchema,
  assignmentRefSchema,
  backendSchema,
  grantsSchema,
  idSchema,
  identitySchema,
  lifetimeSchema,
  memorySchema,
  modelSchema,
  revisionSchema,
  textSchema,
  workspaceSchema,
} from "./common.ts";
import { configLayerSchema } from "./config.ts";
import { applicationCommandSchema } from "./application.ts";

export const workerRequestSchema = z.strictObject({
  id: idSchema,
  agent: idSchema,
  task: textSchema,
  origin: assignmentRefSchema.optional(),
  messageId: identitySchema.optional(),
  after: z.array(z.union([idSchema, assignmentRefSchema])).default([]),
  inputs: z
    .array(assignmentRefSchema)
    .default([])
    .describe(
      "Workspace snapshots to compose, NOT reports or conversation. For report synthesis use after for ordering, query result/conversation, and supply report text in context.",
    ),
  workspace: workspaceSchema.optional(),
  observeWorkspace: z.boolean().optional(),
  model: modelSchema.optional(),
  backend: backendSchema.optional(),
  lifetime: lifetimeSchema.optional(),
  context: z
    .array(z.string())
    .default([])
    .describe(
      "Quoted context text, such as upstream report contents. Assignment references in inputs do not import reports.",
    ),
  inheritContext: z.enum(["none", "parent"]).optional(),
  memory: memorySchema.optional(),
  delegation: z.strictObject({ maxDepth: revisionSchema }).optional(),
});
export type WorkerRequest = z.infer<typeof workerRequestSchema>;
export const frozenWorkerSchema = z.strictObject({
  id: idSchema,
  agent: idSchema,
  definition: artifactRefSchema,
  color: agentColorSchema.optional(),
  loadout: artifactRefSchema.optional(),
  model: modelSchema.optional(),
  fallbacks: z.array(modelSchema),
  tools: z.array(textSchema),
  access: accessSchema,
  workspace: workspaceSchema,
  observeWorkspace: z.boolean().optional(),
  backend: backendSchema,
  lifetime: lifetimeSchema,
  grants: grantsSchema,
  origin: assignmentRefSchema.optional(),
  parentAssignment: assignmentRefSchema.optional(),
  depth: revisionSchema.default(0),
  config: artifactRefSchema.optional(),
  context: artifactRefSchema.optional(),
  workspacePlan: artifactRefSchema.optional(),
});
export type FrozenWorker = z.infer<typeof frozenWorkerSchema>;
export const triggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("at"), at: z.iso.datetime({ offset: true }) }),
  z.strictObject({ kind: z.literal("interval"), milliseconds: revisionSchema.positive() }),
  z.strictObject({ kind: z.literal("cron"), expression: textSchema, timezone: textSchema }),
]);
export const scheduleActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    id: idSchema,
    target: z.union([
      z.strictObject({ worker: idSchema }),
      z.strictObject({ template: workerRequestSchema }),
    ]),
    trigger: triggerSchema,
    overlap: z.enum(["skip", "queue"]).default("skip"),
  }),
  z.strictObject({
    action: z.literal("update"),
    id: idSchema,
    target: z
      .union([
        z.strictObject({ worker: idSchema }),
        z.strictObject({ template: workerRequestSchema }),
      ])
      .optional(),
    trigger: triggerSchema.optional(),
    overlap: z.enum(["skip", "queue"]).optional(),
  }),
  z.strictObject({ action: z.literal("pause"), id: idSchema }),
  z.strictObject({ action: z.literal("resume"), id: idSchema }),
  z.strictObject({ action: z.literal("delete"), id: idSchema }),
  z.strictObject({ action: z.literal("list") }),
]);
export const runtimeCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("create"),
    workers: z.array(workerRequestSchema).min(1),
    config: configLayerSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("add"), workers: z.array(workerRequestSchema).min(1) }),
  z.strictObject({
    kind: z.literal("follow_up"),
    worker: idSchema,
    messageId: identitySchema,
    text: textSchema,
    after: z.array(z.union([idSchema, assignmentRefSchema])).default([]),
    inputs: z
      .array(assignmentRefSchema)
      .default([])
      .describe(
        "Workspace snapshots to compose, NOT reports or conversation. For report synthesis use after for ordering, query result/conversation, and supply report text in context.",
      ),
  }),
  z.strictObject({
    kind: z.literal("steer"),
    worker: idSchema,
    messageId: identitySchema,
    text: textSchema,
  }),
  z.strictObject({
    kind: z.literal("cancel"),
    scope: z.enum(["assignment", "worker", "run"]),
    worker: idSchema.optional(),
    assignment: revisionSchema.positive().optional(),
    descendants: z.boolean().default(true),
  }),
  z.strictObject({ kind: z.literal("background") }),
  z.strictObject({
    kind: z.literal("continue"),
    worker: idSchema,
    messageId: identitySchema,
    text: textSchema,
  }),
  z.strictObject({
    kind: z.literal("capacity"),
    maxConcurrent: revisionSchema.positive().nullable(),
  }),
  z.strictObject({ kind: z.literal("schedule"), schedule: scheduleActionSchema }),
  ...applicationCommandSchema.options,
]);
export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;
export const commandEnvelopeSchema = z.strictObject({
  requestId: identitySchema,
  expectedRevision: revisionSchema.optional(),
  command: runtimeCommandSchema,
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export const jobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workers: z.array(workerRequestSchema).min(1),
  config: configLayerSchema.optional(),
});
export type Job = z.infer<typeof jobSchema>;
