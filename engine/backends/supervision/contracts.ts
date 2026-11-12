import { z } from "zod";
import {
  artifactRefSchema,
  identitySchema,
  revisionSchema,
  textSchema,
} from "../../contracts/common.ts";
import { cleanupReceiptSchema } from "../../contracts/backend.ts";

export const processIdentitySchema = z.strictObject({
  pid: revisionSchema.positive(),
  parent: revisionSchema,
  group: revisionSchema,
  startIdentity: textSchema,
  state: textSchema,
});
export type ProcessIdentity = z.infer<typeof processIdentitySchema>;

export const supervisorIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  ownerEpoch: identitySchema,
  host: textSchema,
  platform: z.enum(["linux", "darwin", "win32"]),
  process: processIdentitySchema,
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("posix-group"), group: revisionSchema.positive() }),
    z.strictObject({
      kind: z.literal("windows-job"),
      name: textSchema,
      launcherId: z.uuid(),
      launcher: processIdentitySchema,
    }),
  ]),
  endpoint: z.strictObject({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65535),
  }),
  nonce: z.uuid(),
  directory: textSchema,
  lifetime: z.enum(["attached", "surviving"]),
});
export type SupervisorIdentity = z.infer<typeof supervisorIdentitySchema>;

export const bootstrapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  nonce: z.uuid(),
  ownerEpoch: identitySchema,
  directory: textSchema,
  lifetime: z.enum(["attached", "surviving"]),
});

export const payloadSchema = z.strictObject({
  command: textSchema,
  args: z.array(z.string()),
  cwd: textSchema,
  env: z.record(z.string(), z.string()).optional(),
});
export type Payload = z.infer<typeof payloadSchema>;

export const supervisorEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("output"),
    source: identitySchema,
    ordinal: revisionSchema.positive(),
    stream: z.enum(["stdout", "stderr"]),
    offset: revisionSchema,
    length: revisionSchema,
    data: z.string(),
  }),
  z.strictObject({
    kind: z.literal("exit"),
    source: identitySchema,
    ordinal: revisionSchema.positive(),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: revisionSchema,
    stderr: revisionSchema,
  }),
  z.strictObject({
    kind: z.literal("failure"),
    source: identitySchema,
    ordinal: revisionSchema.positive(),
    message: textSchema,
  }),
  z.strictObject({
    kind: z.literal("output_drained"),
    source: identitySchema,
    ordinal: revisionSchema.positive(),
    stdout: revisionSchema,
    stderr: revisionSchema,
  }),
]);
export type SupervisorEvent = z.infer<typeof supervisorEventSchema>;
export const supervisorLogEventSchema = z.discriminatedUnion("kind", [
  supervisorEventSchema.options[0].omit({ data: true }),
  supervisorEventSchema.options[1],
  supervisorEventSchema.options[2],
  supervisorEventSchema.options[3],
]);
export const enrollmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  supervisor: z.uuid(),
  enrolled: z.array(processIdentitySchema),
  escaped: z.array(processIdentitySchema),
});

export const stopEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  supervisor: z.uuid(),
  ownerEpoch: identitySchema,
  phase: z.enum(["requested", "armed"]),
  reason: textSchema,
  observedAt: z.iso.datetime(),
  enrolled: z.array(processIdentitySchema),
  escaped: z.array(processIdentitySchema),
  observationErrors: z.array(textSchema),
  windows: z
    .strictObject({
      jobName: textSchema,
      launcherId: z.uuid(),
      activeProcesses: z.literal(0),
      closed: z.literal(true),
    })
    .optional(),
});
export type StopEvidence = z.infer<typeof stopEvidenceSchema>;
export const stopFileSchema = z.strictObject({
  record: stopEvidenceSchema,
  artifact: artifactRefSchema,
});

export const statusSchema = z.strictObject({
  supervisor: z.uuid(),
  phase: z.enum(["ready", "running", "exited", "stopping", "failed"]),
  ordinal: revisionSchema,
  stdout: revisionSchema,
  stderr: revisionSchema,
  outputDrained: z.boolean(),
  enrolled: z.array(processIdentitySchema),
  escaped: z.array(processIdentitySchema),
  exit: z
    .strictObject({ code: z.number().int().nullable(), signal: z.string().nullable() })
    .optional(),
});
export type SupervisorStatus = z.infer<typeof statusSchema>;

// Relay messages are disposable hints or display snapshots, never durable evidence.
export const relayMessageSchema = z.strictObject({
  topic: z.string().min(1).max(64),
  value: z.json(),
});
export type RelayMessage = z.infer<typeof relayMessageSchema>;

export const controlActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("ping") }),
  z.strictObject({ action: z.literal("inspect") }),
  z.strictObject({ action: z.literal("observe") }),
  z.strictObject({
    action: z.literal("subscribe"),
    topics: z.array(z.string().min(1).max(64)).max(16),
  }),
  relayMessageSchema.extend({ action: z.literal("relay") }),
  z.strictObject({ action: z.literal("start"), payload: payloadSchema }),
  z.strictObject({ action: z.literal("input"), text: z.string().max(1_048_576) }),
  z.strictObject({ action: z.literal("input_end") }),
  z.strictObject({ action: z.literal("enroll"), pid: revisionSchema.positive() }),
  z.strictObject({
    action: z.literal("stop"),
    reason: textSchema,
    graceMs: z.number().int().min(0).max(30_000),
  }),
]);
export type ControlAction = z.infer<typeof controlActionSchema>;
export const controlRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  supervisor: z.uuid(),
  nonce: z.uuid(),
  command: controlActionSchema,
});
export const controlPacketSchema = z.union([
  z.strictObject({
    kind: z.literal("response"),
    id: z.uuid(),
    ok: z.literal(true),
    value: z.json(),
  }),
  z.strictObject({
    kind: z.literal("response"),
    id: z.uuid(),
    ok: z.literal(false),
    error: textSchema,
  }),
  z.strictObject({ kind: z.literal("event"), event: supervisorEventSchema }),
  relayMessageSchema.extend({ kind: z.literal("relay") }),
]);
export const stopResponseSchema = z.strictObject({ stopId: z.uuid(), evidence: artifactRefSchema });
export const savedCleanupSchema = z.strictObject({
  schemaVersion: z.literal(1),
  supervisor: z.uuid(),
  receipt: cleanupReceiptSchema,
  receiptArtifact: artifactRefSchema,
});

export function processKey(identity: ProcessIdentity): string {
  return `${identity.pid}/${identity.startIdentity}`;
}

export function publicSupervisorId(identity: Pick<SupervisorIdentity, "id">): string {
  return `guardian:${identity.id}`;
}
