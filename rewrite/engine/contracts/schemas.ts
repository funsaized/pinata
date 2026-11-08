import { z } from "zod";
import {
  applicationJournalSchema,
  applicationCursorSchema,
  applicationReceiptSchema,
} from "./application.ts";
import {
  workspaceSnapshotSchema,
  workspaceManifestSchema,
  workspacePlanSchema,
} from "./workspace.ts";
import { commandEnvelopeSchema, jobSchema, workerRequestSchema } from "./commands.ts";
import { configSchema } from "./config.ts";
import { definitionSchema } from "./definition.ts";
import {
  commandReceiptSchema,
  coreStateSchema,
  inboxMessageSchema,
  resultSchema,
  transitionSchema,
} from "./lifecycle.ts";
import {
  queryResultSchema,
  recoveryReceiptSchema,
  recoveryRequestSchema,
  runtimeEventSchema,
  runtimeQuerySchema,
  subscriptionSchema,
} from "./runtime.ts";
import { checkpointSchema, journalFrameSchema, manifestSchema, ownerSchema } from "./storage.ts";
import {
  backendCapabilitiesSchema,
  backendLaunchWireSchema,
  backendObservationSchema,
  backendOutcomeSchema,
  cleanupReceiptSchema,
  reportedResultSchema,
  sessionCheckpointSchema,
} from "./backend.ts";
import { checkoutIdentitySchema, exclusiveLeaseSchema, writerLeaseSchema } from "./gate.ts";

export const schemaRegistry = {
  "pinata.application-journal.v4": applicationJournalSchema,
  "pinata.application-cursor.v1": applicationCursorSchema,
  "pinata.application-receipt.v1": applicationReceiptSchema,
  "pinata.workspace-snapshot.v1": workspaceSnapshotSchema,
  "pinata.workspace-manifest.v1": workspaceManifestSchema,
  "pinata.workspace-plan.v1": workspacePlanSchema,
  "pinata.command.v1": commandEnvelopeSchema,
  "pinata.receipt.v1": commandReceiptSchema,
  "pinata.job.v4": jobSchema,
  "pinata.config.v4": configSchema,
  "pinata.definition.v3": definitionSchema,
  "pinata.worker.v1": workerRequestSchema,
  "pinata.result.v1": reportedResultSchema,
  "pinata.assignment-result.v1": resultSchema,
  "pinata.inbox.v1": inboxMessageSchema,
  "pinata.transition.v1": transitionSchema,
  "pinata.state.v1": coreStateSchema,
  "pinata.event.v3": runtimeEventSchema,
  "pinata.query.v1": runtimeQuerySchema,
  "pinata.query-result.v1": queryResultSchema,
  "pinata.subscription.v1": subscriptionSchema,
  "pinata.recovery-request.v1": recoveryRequestSchema,
  "pinata.recovery-receipt.v1": recoveryReceiptSchema,
  "pinata.manifest.v4": manifestSchema,
  "pinata.journal.v1": journalFrameSchema,
  "pinata.owner.v1": ownerSchema,
  "pinata.checkpoint.v1": checkpointSchema,
  "pinata.backend-capabilities.v1": backendCapabilitiesSchema,
  "pinata.backend-launch.v1": backendLaunchWireSchema,
  "pinata.backend-observation.v1": backendObservationSchema,
  "pinata.backend-outcome.v1": backendOutcomeSchema,
  "pinata.cleanup-receipt.v1": cleanupReceiptSchema,
  "pinata.session-checkpoint.v1": sessionCheckpointSchema,
  "pinata.checkout-identity.v1": checkoutIdentitySchema,
  "pinata.writer-lease.v1": writerLeaseSchema,
  "pinata.exclusive-lease.v1": exclusiveLeaseSchema,
} as const;
export type SchemaName = keyof typeof schemaRegistry;

// Cross-field grants, graph references, receipt/journal consistency and NUL rejection
// require canonical validation after transport normalization; JSON Schema is not authority.
export function exportSchemas(): Record<string, z.core.JSONSchema.JSONSchema> {
  return Object.fromEntries(
    Object.entries(schemaRegistry).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { target: "draft-07", io: "input" }),
    ]),
  );
}

export function parseSchema(
  name: SchemaName,
  value: unknown,
): z.output<(typeof schemaRegistry)[SchemaName]> {
  return schemaRegistry[name].parse(value);
}
