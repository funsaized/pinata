import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  backendIdentitySchema,
  backendLaunchWireSchema,
  backendObservationSchema,
  backendOutcomeSchema,
  artifactRefSchema,
  assignmentRefSchema,
  canonicalJson,
  digestSchema,
  digestValue,
  cleanupReceiptSchema,
  identitySchema,
  inboxMessageSchema,
  revisionSchema,
  resultSchema,
  sessionCheckpointSchema,
  textSchema,
  transportReceiptSchema,
  type ArtifactPort,
} from "../contracts/index.ts";
import { digestBytes, isMissing, publishImmutable } from "../storage/io.ts";
import { verifyArtifact } from "../storage/journal.ts";
import { supervisorIdentitySchema } from "./supervision/contracts.ts";

export const processOptionsSchema = z.strictObject({
  agentDir: textSchema,
  codemode: z.boolean().optional(),
  extensions: z.array(textSchema).optional(),
  bootstrapModule: textSchema.optional(),
  nodeCommand: textSchema.optional(),
});
export type WorkerProcessOptions = z.infer<typeof processOptionsSchema>;
export const processManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: backendIdentitySchema,
  launch: backendLaunchWireSchema,
  options: processOptionsSchema,
});
export type ProcessManifest = z.infer<typeof processManifestSchema>;
export const processBriefSchema = z.strictObject({
  task: z.string(),
  context: z.array(z.string()),
  dependencies: z.array(
    z.strictObject({
      ref: assignmentRefSchema,
      result: resultSchema,
      artifact: artifactRefSchema,
    }),
  ),
});
export const processOutcomeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  throughOrdinal: revisionSchema.positive(),
  outcome: backendOutcomeSchema,
});
export const processEnrollmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: backendIdentitySchema,
  supervisor: supervisorIdentitySchema,
});
export const processObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceId: identitySchema,
  ordinal: revisionSchema.positive(),
  observation: backendObservationSchema,
});
export const processActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("input"), message: inboxMessageSchema }),
  z.strictObject({ action: z.literal("checkpoint") }),
  z.strictObject({ action: z.literal("stop"), reason: textSchema }),
  z.strictObject({ action: z.literal("attach"), runtimeOwnerEpoch: identitySchema }),
]);
export type ProcessAction = z.infer<typeof processActionSchema>;
export const processCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identitySchema,
  ordinal: revisionSchema.positive(),
  runtimeOwnerEpoch: identitySchema,
  command: processActionSchema,
});
export type ProcessCommand = z.infer<typeof processCommandSchema>;
export const processStopSchema = z.strictObject({
  cleanup: cleanupReceiptSchema,
  outcome: backendOutcomeSchema.optional(),
  checkpoint: sessionCheckpointSchema.optional(),
});
export const processResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    id: identitySchema,
    ordinal: revisionSchema.positive(),
    receipt: transportReceiptSchema.optional(),
    checkpoint: sessionCheckpointSchema.optional(),
    stopped: processStopSchema.optional(),
    runtimeOwnerEpoch: identitySchema.optional(),
  }),
  z.strictObject({
    status: z.literal("error"),
    id: identitySchema,
    ordinal: revisionSchema.positive(),
    error: textSchema,
  }),
]);
export type ProcessResponse = z.infer<typeof processResponseSchema>;
export const processReadySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready") }),
  z.strictObject({
    status: z.literal("failed"),
    error: textSchema,
    cleanup: cleanupReceiptSchema.optional(),
  }),
]);

export function numberedPath(directory: string, stream: string, ordinal: number): string {
  return join(directory, stream, `${String(ordinal).padStart(16, "0")}.json`);
}
const transportFrameSchema = z.strictObject({
  schemaVersion: z.literal(1),
  digest: digestSchema,
  payload: z.unknown(),
});
export async function writeRecord(path: string, value: unknown): Promise<void> {
  await publishImmutable(
    path,
    Buffer.from(canonicalJson({ schemaVersion: 1, digest: digestValue(value), payload: value })),
    "process-transport",
  );
}
export async function readRecord<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const frame = transportFrameSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (digestValue(frame.payload) !== frame.digest)
      throw new Error("Worker transport payload digest does not match its retained frame");
    return schema.parse(frame.payload);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
export async function readCommands(directory: string): Promise<ProcessCommand[]> {
  let entries: string[];
  try {
    entries = await readdir(join(directory, "commands"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files = entries.filter((entry) => /^\d{16}\.json$/.test(entry)).sort();
  const commands: ProcessCommand[] = [];
  for (const name of files) {
    const command = await readRecord(join(directory, "commands", name), processCommandSchema);
    if (!command || command.ordinal !== commands.length + 1)
      throw new Error("Worker command stream has a missing or mismatched ordinal");
    commands.push(command);
  }
  return commands;
}

// Workers publish immutable content and their own transport outbox. Only the
// owning Runtime may append lifecycle transitions to the run journal.
export function processArtifacts(storeDirectory: string): ArtifactPort {
  return {
    async put(bytes) {
      const reference = { digest: digestBytes(bytes), size: bytes.byteLength };
      await publishImmutable(
        join(storeDirectory, "artifacts", reference.digest),
        bytes,
        "process-artifact",
      );
      return reference;
    },
    read: (reference) => verifyArtifact(storeDirectory, reference),
  };
}
