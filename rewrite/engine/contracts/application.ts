import { z } from "zod";
import {
  artifactRefSchema,
  commandErrorSchema,
  assignmentRefSchema,
  identitySchema,
  revisionSchema,
  textSchema,
} from "./common.ts";
import { gitObjectSchema, repositoryObservationSchema } from "./workspace.ts";
import { exclusiveLeaseSchema } from "./gate.ts";

export const applicationFileSchema = z.strictObject({
  mode: z.enum(["100644", "100755"]),
  blob: artifactRefSchema,
});
export type ApplicationFile = z.infer<typeof applicationFileSchema>;
export const applicationChangeSchema = z.strictObject({
  path: textSchema,
  before: applicationFileSchema.nullable(),
  after: applicationFileSchema.nullable(),
});
export type ApplicationChange = z.infer<typeof applicationChangeSchema>;
export const applicationCursorSchema = z.strictObject({
  destination: textSchema,
  ref: assignmentRefSchema,
  snapshot: artifactRefSchema,
  manifest: artifactRefSchema,
  tree: gitObjectSchema,
  operationId: identitySchema,
});
export type ApplicationCursor = z.infer<typeof applicationCursorSchema>;
export const applicationCursorsSchema = z.record(z.string(), applicationCursorSchema);
export type ApplicationCursors = z.infer<typeof applicationCursorsSchema>;
export const applicationOperationSchema = z.strictObject({
  id: identitySchema,
  direction: z.enum(["apply", "rollback"]),
  mode: z.enum(["delivery", "input"]).default("delivery"),
  phase: z.enum(["pending", "applied", "rolled_back"]),
  rollbackOf: identitySchema.optional(),
  destination: textSchema,
  repository: repositoryObservationSchema,
  snapshot: artifactRefSchema,
  changes: z.array(applicationChangeSchema),
  beforeCursors: applicationCursorsSchema,
  afterCursors: applicationCursorsSchema,
  lease: exclusiveLeaseSchema,
});
export type ApplicationOperation = z.infer<typeof applicationOperationSchema>;
export const applicationJournalSchema = z.strictObject({
  schemaVersion: z.literal(4),
  kind: z.literal("pinata-application-journal"),
  destination: textSchema,
  revision: revisionSchema,
  cursors: applicationCursorsSchema,
  operations: z.array(applicationOperationSchema),
});
export type ApplicationJournal = z.infer<typeof applicationJournalSchema>;
export const applicationReceiptSchema = z.strictObject({
  status: z.enum(["applied", "rolled_back", "already_recorded"]),
  operationId: identitySchema,
  destination: textSchema,
  revision: revisionSchema,
  snapshot: artifactRefSchema,
  freshness: z.enum(["matching", "changed", "unknown"]),
});
export type ApplicationReceipt = z.infer<typeof applicationReceiptSchema>;

export const applicationCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("apply"), ref: assignmentRefSchema, destination: textSchema }),
  z.strictObject({
    kind: z.literal("rollback"),
    operation: identitySchema,
    destination: textSchema,
  }),
  z.strictObject({
    kind: z.literal("reconcile"),
    operation: identitySchema,
    owner: identitySchema,
  }),
]);
export type ApplicationCommand = z.infer<typeof applicationCommandSchema>;
export const applicationIntentSchema = z.strictObject({
  id: identitySchema,
  requestId: identitySchema,
  command: applicationCommandSchema,
  ownerEpoch: identitySchema,
  destination: textSchema,
  ref: assignmentRefSchema,
  snapshot: artifactRefSchema,
  targetOperation: identitySchema.optional(),
});
export type ApplicationIntent = z.infer<typeof applicationIntentSchema>;
export const applicationStateSchema = z.strictObject({
  intent: applicationIntentSchema,
  status: z.enum(["pending", "completed", "failed", "uncertain"]),
  receipt: applicationReceiptSchema.nullable().optional(),
  error: commandErrorSchema.optional(),
  evidence: artifactRefSchema.optional(),
});
export type ApplicationState = z.infer<typeof applicationStateSchema>;
export type ApplicationObservation = Omit<ApplicationState, "intent" | "status"> & {
  status: Exclude<ApplicationState["status"], "pending">;
};
