import { scheduleStateSchema, scheduleOccurrenceSchema } from "./schedule.ts";
import { toolPageRequestSchema, toolPageSchema, toolPageReplySchema } from "./pages.ts";
import { z } from "zod";
import { dependencyQuerySchema, dependencyPageSchema } from "./dependencies.ts";
import { grantsSchema, commandErrorSchema } from "./common.ts";
import {
  ipcLimitsSchema,
  ipcLinkSchema,
  ipcCredentialsSchema,
  helloSchema,
  clientFrameSchema,
  serverFrameSchema,
  serverMessageSchema,
  notificationNoticeSchema,
} from "./ipc.ts";
import {
  childCommandEnvelopeSchema,
  childQuerySchema,
  childQueryResultSchema,
  childWaitSchema,
  childWaitResultSchema,
} from "./delegation.ts";
import { migrationManifestSchema } from "./migration.ts";
import { legacyQuiescenceSchema, legacyQuiescenceObservationSchema } from "./history.ts";
import {
  memorySnapshotSchema,
  memoryRevisionSchema,
  memoryEditSchema,
  memoryClearSchema,
} from "./memory.ts";
import {
  applicationJournalSchema,
  applicationCursorSchema,
  applicationReceiptSchema,
} from "./application.ts";
import {
  workspaceSnapshotSchema,
  workspaceManifestSchema,
  workspacePlanSchema,
  workspaceCheckpointSchema,
} from "./workspace.ts";
import { commandEnvelopeSchema, jobSchema, workerRequestSchema } from "./commands.ts";
import { configSchema, configLayerSchema } from "./config.ts";
import { definitionSchema } from "./definition.ts";
import {
  commandReceiptSchema,
  historyImportSchema,
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
  reportToolResultSchema,
  sessionCheckpointSchema,
} from "./backend.ts";
import { checkoutIdentitySchema, exclusiveLeaseSchema, writerLeaseSchema } from "./gate.ts";
import { surfaceCallSchema, surfaceReplySchema, surfaceCapabilitiesSchema } from "./surface.ts";
import { loadoutSchema } from "./loadout.ts";
import { conversationSeedSchema, instructionSnapshotSchema } from "./context.ts";

export const schemaRegistry = {
  "pinata.tool-page-request.v1": toolPageRequestSchema,
  "pinata.tool-page.v1": toolPageSchema,
  "pinata.tool-page-reply.v1": toolPageReplySchema,
  "pinata.dependency-query.v1": dependencyQuerySchema,
  "pinata.dependency-page.v1": dependencyPageSchema,
  "pinata.ipc-limits.v2": ipcLimitsSchema,
  "pinata.ipc-link.v2": ipcLinkSchema,
  "pinata.ipc-credentials.v2": ipcCredentialsSchema,
  "pinata.ipc-hello.v2": helloSchema,
  "pinata.ipc-client-frame.v2": clientFrameSchema,
  "pinata.ipc-server-frame.v2": serverFrameSchema,
  "pinata.ipc-server-message.v2": serverMessageSchema,
  "pinata.ipc-notice.v2": notificationNoticeSchema,
  "pinata.grants.v1": grantsSchema,
  "pinata.error.v1": commandErrorSchema,
  "pinata.schedule.v1": scheduleStateSchema,
  "pinata.schedule-occurrence.v1": scheduleOccurrenceSchema,
  "pinata.child-command.v1": childCommandEnvelopeSchema,
  "pinata.child-query.v1": childQuerySchema,
  "pinata.child-query-result.v1": childQueryResultSchema,
  "pinata.child-wait.v1": childWaitSchema,
  "pinata.child-wait-result.v1": childWaitResultSchema,
  "pinata.workspace-checkpoint.v1": workspaceCheckpointSchema,
  "pinata.migration-manifest.v1": migrationManifestSchema,
  "pinata.legacy-quiescence.v1": legacyQuiescenceSchema,
  "pinata.legacy-quiescence-observation.v1": legacyQuiescenceObservationSchema,
  "pinata.loadout.v1": loadoutSchema,
  "pinata.conversation-seed.v1": conversationSeedSchema,
  "pinata.instruction-snapshot.v1": instructionSnapshotSchema,
  "pinata.surface-call.v1": surfaceCallSchema,
  "pinata.surface-reply.v1": surfaceReplySchema,
  "pinata.surface-capabilities.v1": surfaceCapabilitiesSchema,
  "pinata.application-journal.v4": applicationJournalSchema,
  "pinata.application-cursor.v1": applicationCursorSchema,
  "pinata.application-receipt.v1": applicationReceiptSchema,
  "pinata.workspace-snapshot.v1": workspaceSnapshotSchema,
  "pinata.workspace-manifest.v1": workspaceManifestSchema,
  "pinata.workspace-plan.v1": workspacePlanSchema,
  "pinata.memory-snapshot.v1": memorySnapshotSchema,
  "pinata.memory-revision.v1": memoryRevisionSchema,
  "pinata.memory-edit.v1": memoryEditSchema,
  "pinata.memory-clear.v1": memoryClearSchema,
  "pinata.history-import.v1": historyImportSchema,
  "pinata.command.v1": commandEnvelopeSchema,
  "pinata.receipt.v1": commandReceiptSchema,
  "pinata.job.v4": jobSchema,
  "pinata.config.v4": configSchema,
  "pinata.config-layer.v4": configLayerSchema,
  "pinata.definition.v3": definitionSchema,
  "pinata.worker.v1": workerRequestSchema,
  "pinata.result.v1": reportedResultSchema,
  "pinata.report-tool-result.v1": reportToolResultSchema,
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
