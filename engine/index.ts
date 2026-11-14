// Public integration entry. Pure contracts and Runtime also have separate package
// exports so consumers that do not host Pi sessions need not load the Pi SDK.
export { openHost, type Host, type HostOptions } from "./host/index.ts";
export { defineAgent, type AgentDefinitionInput, type DefinedAgent } from "./definitions/typed.ts";
export { Runtime, type RuntimeOptions } from "./runtime/index.ts";
export { bindRuntime, type RuntimeSource } from "./sources/runtime.ts";
export { ToolPages, toolContentBytes } from "./sources/pages.ts";
export { openSavedSource } from "./sources/saved.ts";
export { exportSchemas, parseSchema, schemaRegistry } from "./contracts/schemas.ts";
export type {
  AssignmentRef,
  CallerAuthority,
  CommandEnvelope,
  CommandReceipt,
  RuntimeEvent,
  SurfaceCall,
  SurfaceReply,
} from "./contracts/index.ts";
