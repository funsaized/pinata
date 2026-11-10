import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import {
  canonicalJson,
  commandEnvelopeSchema,
  digestSchema,
  digestValue,
  DomainError,
  identitySchema,
  type CommandEnvelope,
} from "../contracts/index.ts";
import { digestBytes, publishImmutable } from "../storage/io.ts";

const inputType = "pinata.input.v3";
const intentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  session: identitySchema,
  entry: identitySchema,
  text: z.string(),
  run: identitySchema,
  envelope: commandEnvelopeSchema,
});
type MentionIntent = z.infer<typeof intentSchema>;
export type MentionInput = Pick<MentionIntent, "session" | "entry" | "text">;

// Pi emits handled input before it has a user-message entry. Create an explicit
// parent input entry through its public API, then retain the routed envelope in
// the run store: a custom-only first Pi session may not yet exist on disk.
export function recordMentionInput(
  pi: ExtensionAPI,
  context: ExtensionContext,
  event: InputEvent,
): MentionInput {
  const session = context.sessionManager.getSessionId();
  pi.appendEntry(inputType, { session, text: event.text });
  const entry = context.sessionManager.getLeafEntry();
  if (entry?.type !== "custom" || entry.customType !== inputType)
    throw new DomainError("context_unavailable", "Pi did not retain the addressed input entry");
  return { session, entry: entry.id, text: event.text };
}

export function mentionRequestId(input: MentionInput): string {
  return digestValue({ session: input.session, entry: input.entry });
}

export async function retainMentionIntent(
  directory: string,
  input: MentionInput,
  run: string,
  envelope: CommandEnvelope,
): Promise<string> {
  const intent = intentSchema.parse({ schemaVersion: 1, ...input, run, envelope });
  if (envelope.requestId !== mentionRequestId(input))
    throw new DomainError("invalid_input", "Mention request differs from its input entry identity");
  const bytes = Buffer.from(canonicalJson(intent));
  const token = digestBytes(bytes);
  await publishImmutable(
    join(directory, "mention-inputs", `${token}.json`),
    bytes,
    "mention-input",
  );
  return token;
}

export async function readMentionIntent(
  directory: string,
  token: string,
  scope: { run: string; session: string },
): Promise<MentionIntent> {
  const digest = digestSchema.parse(token);
  const bytes = await readFile(join(directory, "mention-inputs", `${digest}.json`));
  if (digestBytes(bytes) !== digest)
    throw new DomainError(
      "context_unavailable",
      "Retained mention input failed its integrity check",
    );
  const intent = intentSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    intent.run !== scope.run ||
    intent.session !== scope.session ||
    intent.envelope.requestId !== mentionRequestId(intent)
  )
    throw new DomainError(
      "capability_denied",
      "Retained mention input belongs to another session or run",
    );
  return intent;
}
