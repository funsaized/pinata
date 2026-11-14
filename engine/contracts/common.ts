import { z } from "zod";

export const versions = Object.freeze({
  command: 2,
  config: 1,
  definition: 1,
  manifest: 1,
  journal: 1,
  event: 1,
  extension: 1,
});
export const textSchema = z
  .string()
  .min(1)
  .refine((text) => !text.includes("\0"), "NUL is not allowed");
export const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const identitySchema = textSchema;
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const assignmentRefSchema = z.strictObject({
  run: identitySchema,
  worker: idSchema,
  assignment: revisionSchema.positive(),
});
export type AssignmentRef = z.infer<typeof assignmentRefSchema>;
export const artifactRefSchema = z.strictObject({ digest: digestSchema, size: revisionSchema });
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export const backendSchema = z.enum(["in-process", "process", "herdr-pi"]);
export const workspaceSchema = z.enum(["shared", "worktree"]);
export const lifetimeSchema = z.enum(["attached", "surviving"]);
export const accessSchema = z.enum(["read", "write"]);
export const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const modelSchema = z.strictObject({
  provider: textSchema,
  id: textSchema,
  thinking: thinkingSchema,
});
export type ModelRef = z.infer<typeof modelSchema>;
export const memorySchema = z.strictObject({
  scope: z.enum(["none", "worker", "project-agent"]),
  access: accessSchema,
});
export const delegationSchema = z.strictObject({
  maxDepth: revisionSchema,
  agents: z.array(idSchema),
  tools: z.array(textSchema),
  workspaces: z.array(workspaceSchema),
});
export const grantsSchema = z.strictObject({
  access: accessSchema,
  tools: z.array(textSchema),
  workspaces: z.array(workspaceSchema),
  inheritContext: z.boolean(),
  memory: memorySchema,
  delegation: delegationSchema,
});
export type Grants = z.infer<typeof grantsSchema>;
// Constructed by a trusted host or authenticated transport, never parsed from model command JSON.
export type CallerAuthority = {
  id: string;
  kind: "coordinator" | "worker" | "viewer";
  run: string;
  grants: Grants;
  parentAssignment?: AssignmentRef;
};
export const errorCodeSchema = z.enum([
  "invalid_input",
  "dependency_missing",
  "capability_denied",
  "unsupported",
  "conflict",
  "owner_unconfirmed",
  "context_unavailable",
  "commit_unknown",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const commandErrorSchema = z.strictObject({
  code: errorCodeSchema,
  message: textSchema,
  field: textSchema.optional(),
});
export type CommandError = z.infer<typeof commandErrorSchema>;
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly field?: string;
  constructor(code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.field = field;
  }
  toJSON(): CommandError {
    return { code: this.code, message: this.message, ...(this.field ? { field: this.field } : {}) };
  }
}

export function assignmentKey(ref: AssignmentRef): string {
  return JSON.stringify([ref.run, ref.worker, ref.assignment]);
}
