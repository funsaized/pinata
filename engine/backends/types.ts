// Backend contracts live in engine/core/types.ts; this module re-exports them for backends.
export type {
  AgentBackend,
  AgentEventInput,
  AgentHandle,
  AgentLaunch,
  AgentOutcome,
  AgentResult,
  AgentSnapshot,
  BackendKind,
  StopReason,
  Usage,
} from "../core/types.ts";
