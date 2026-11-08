import { z } from "zod";
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
  runtimeEventSchema,
  runtimeQuerySchema,
  subscriptionSchema,
} from "./runtime.ts";
import { checkpointSchema, journalFrameSchema, manifestSchema, ownerSchema } from "./storage.ts";

export const schemaRegistry = {
  "pinata.command.v1": commandEnvelopeSchema,
  "pinata.receipt.v1": commandReceiptSchema,
  "pinata.job.v4": jobSchema,
  "pinata.config.v4": configSchema,
  "pinata.definition.v3": definitionSchema,
  "pinata.worker.v1": workerRequestSchema,
  "pinata.result.v1": resultSchema,
  "pinata.inbox.v1": inboxMessageSchema,
  "pinata.transition.v1": transitionSchema,
  "pinata.state.v1": coreStateSchema,
  "pinata.event.v3": runtimeEventSchema,
  "pinata.query.v1": runtimeQuerySchema,
  "pinata.query-result.v1": queryResultSchema,
  "pinata.subscription.v1": subscriptionSchema,
  "pinata.manifest.v4": manifestSchema,
  "pinata.journal.v1": journalFrameSchema,
  "pinata.owner.v1": ownerSchema,
  "pinata.checkpoint.v1": checkpointSchema,
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
