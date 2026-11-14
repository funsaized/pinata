// Deliberate external surface. Implementation modules may use the wider internal
// barrel; integrations discover individual schemas through the canonical registry.
export { assignmentKey, DomainError, versions } from "./common.ts";
export { canonicalJson, digestValue } from "./digest.ts";
export { exportSchemas, parseSchema, schemaRegistry } from "./schemas.ts";
export type * from "./index.ts";
export {
  extensionChannels,
  extensionProtocolVersion,
  extensionRequestSchema,
  extensionReplySchema,
  extensionReadySchema,
  extensionEventSchema,
} from "./extension.ts";
