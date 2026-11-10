import { z } from "zod";
import {
  assignmentRefSchema,
  idSchema,
  identitySchema,
  revisionSchema,
  textSchema,
} from "./common.ts";
import { frozenWorkerSchema, triggerSchema, workerRequestSchema } from "./commands.ts";

export const scheduleOccurrenceSchema = z.strictObject({
  scheduledAt: z.iso.datetime(),
  status: z.enum(["accepted", "skipped", "missed"]),
  ref: assignmentRefSchema.optional(),
  reason: textSchema.optional(),
  through: z.iso.datetime().optional(),
});
export type ScheduleOccurrence = z.infer<typeof scheduleOccurrenceSchema>;
export const scheduleStateSchema = z.strictObject({
  id: idSchema,
  sessionId: identitySchema,
  revision: revisionSchema.positive(),
  trigger: triggerSchema,
  overlap: z.enum(["skip", "queue"]),
  status: z.enum(["paused", "active", "completed", "deleted", "closed"]),
  target: z.strictObject({ worker: idSchema }),
  task: textSchema,
  template: z.strictObject({ request: workerRequestSchema, worker: frozenWorkerSchema }).optional(),
  nextAt: z.iso.datetime().nullable(),
  lastLocalKey: textSchema.optional(),
  activatedAt: z.iso.datetime().optional(),
  occurrences: z.record(z.string(), scheduleOccurrenceSchema),
});
export type ScheduleState = z.infer<typeof scheduleStateSchema>;
