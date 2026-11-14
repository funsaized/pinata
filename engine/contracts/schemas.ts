import {
  extensionRequestSchema,
  extensionReplySchema,
  extensionReadySchema,
  extensionEventSchema,
} from "./extension.ts";
import { toolPageRequestSchema, toolPageSchema, toolPageReplySchema } from "./pages.ts";
import type { z } from "zod";
import { DomainError } from "./common.ts";
import { jsonSchema } from "./json-schema.ts";
import { dependencyQuerySchema, dependencyPageSchema } from "./dependencies.ts";
import {
  workerMessageRequestSchema,
  workerMessageReceiptSchema,
  workerMessageSchema,
} from "./messages.ts";
import { grantsSchema, commandErrorSchema } from "./common.ts";
import {
  childCommandEnvelopeSchema,
  childQuerySchema,
  childQueryResultSchema,
  childWaitSchema,
  childWaitResultSchema,
} from "./delegation.ts";
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
  worktreeSchema,
} from "./workspace.ts";
import { commandEnvelopeSchema, workerRequestSchema } from "./commands.ts";
import { configSchema, configLayerSchema } from "./config.ts";
import { definitionSchema } from "./definition.ts";
import {
  commandReceiptSchema,
  notificationAcknowledgmentRequestSchema,
  notificationAcknowledgmentReceiptSchema,
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
import { surfaceCallSchema, surfaceReplySchema, surfaceCapabilitiesSchema } from "./surface.ts";
import { loadoutSchema } from "./loadout.ts";
import { conversationSeedSchema, instructionSnapshotSchema } from "./context.ts";

export const schemaRegistry = {
  "pinata.extension-request.v1": extensionRequestSchema,
  "pinata.extension-reply.v1": extensionReplySchema,
  "pinata.extension-ready.v1": extensionReadySchema,
  "pinata.extension-event.v1": extensionEventSchema,
  "pinata.notification-acknowledgment-request.v1": notificationAcknowledgmentRequestSchema,
  "pinata.notification-acknowledgment-receipt.v1": notificationAcknowledgmentReceiptSchema,
  "pinata.worker-message-request.v1": workerMessageRequestSchema,
  "pinata.worker-message-receipt.v1": workerMessageReceiptSchema,
  "pinata.worker-message.v1": workerMessageSchema,
  "pinata.tool-page-request.v1": toolPageRequestSchema,
  "pinata.tool-page.v1": toolPageSchema,
  "pinata.tool-page-reply.v1": toolPageReplySchema,
  "pinata.dependency-query.v1": dependencyQuerySchema,
  "pinata.dependency-page.v1": dependencyPageSchema,
  "pinata.grants.v1": grantsSchema,
  "pinata.error.v1": commandErrorSchema,
  "pinata.child-command.v1": childCommandEnvelopeSchema,
  "pinata.child-query.v1": childQuerySchema,
  "pinata.child-query-result.v1": childQueryResultSchema,
  "pinata.child-wait.v1": childWaitSchema,
  "pinata.child-wait-result.v1": childWaitResultSchema,
  "pinata.workspace-checkpoint.v1": workspaceCheckpointSchema,
  "pinata.worktree.v1": worktreeSchema,
  "pinata.loadout.v1": loadoutSchema,
  "pinata.conversation-seed.v1": conversationSeedSchema,
  "pinata.instruction-snapshot.v1": instructionSnapshotSchema,
  "pinata.surface-call.v1": surfaceCallSchema,
  "pinata.surface-reply.v1": surfaceReplySchema,
  "pinata.surface-capabilities.v1": surfaceCapabilitiesSchema,
  "pinata.application-journal.v1": applicationJournalSchema,
  "pinata.application-cursor.v1": applicationCursorSchema,
  "pinata.application-receipt.v1": applicationReceiptSchema,
  "pinata.workspace-snapshot.v1": workspaceSnapshotSchema,
  "pinata.workspace-manifest.v1": workspaceManifestSchema,
  "pinata.workspace-plan.v1": workspacePlanSchema,
  "pinata.memory-snapshot.v1": memorySnapshotSchema,
  "pinata.memory-revision.v1": memoryRevisionSchema,
  "pinata.memory-edit.v1": memoryEditSchema,
  "pinata.memory-clear.v1": memoryClearSchema,
  "pinata.command.v2": commandEnvelopeSchema,
  "pinata.receipt.v1": commandReceiptSchema,
  "pinata.config.v1": configSchema,
  "pinata.config-layer.v1": configLayerSchema,
  "pinata.definition.v1": definitionSchema,
  "pinata.worker.v1": workerRequestSchema,
  "pinata.result.v1": reportedResultSchema,
  "pinata.report-tool-result.v1": reportToolResultSchema,
  "pinata.assignment-result.v1": resultSchema,
  "pinata.inbox.v1": inboxMessageSchema,
  "pinata.transition.v1": transitionSchema,
  "pinata.state.v1": coreStateSchema,
  "pinata.event.v1": runtimeEventSchema,
  "pinata.query.v1": runtimeQuerySchema,
  "pinata.query-result.v1": queryResultSchema,
  "pinata.subscription.v1": subscriptionSchema,
  "pinata.recovery-request.v1": recoveryRequestSchema,
  "pinata.recovery-receipt.v1": recoveryReceiptSchema,
  "pinata.manifest.v1": manifestSchema,
  "pinata.journal.v1": journalFrameSchema,
  "pinata.owner.v1": ownerSchema,
  "pinata.checkpoint.v1": checkpointSchema,
  "pinata.backend-capabilities.v1": backendCapabilitiesSchema,
  "pinata.backend-launch.v1": backendLaunchWireSchema,
  "pinata.backend-observation.v1": backendObservationSchema,
  "pinata.backend-outcome.v1": backendOutcomeSchema,
  "pinata.cleanup-receipt.v1": cleanupReceiptSchema,
  "pinata.session-checkpoint.v1": sessionCheckpointSchema,
} as const;
export type SchemaName = keyof typeof schemaRegistry;

// Cross-field grants, graph references, receipt/journal consistency and NUL rejection
// require canonical validation after transport normalization; JSON Schema is not authority.
export function exportSchemas(name?: string): Record<string, z.core.JSONSchema.JSONSchema> {
  if (name && !Object.hasOwn(schemaRegistry, name))
    throw new DomainError(
      "invalid_input",
      `Unknown schema: ${name}. Available names: ${Object.keys(schemaRegistry).join(", ")}`,
      "name",
    );
  const names = name ? [name as SchemaName] : (Object.keys(schemaRegistry) as SchemaName[]);
  return Object.fromEntries(names.map((key) => [key, jsonSchema(schemaRegistry[key])]));
}

export function parseSchema(
  name: SchemaName,
  value: unknown,
): z.output<(typeof schemaRegistry)[SchemaName]> {
  return schemaRegistry[name].parse(value);
}
