// Feasibility spike only. This is deliberately not imported by production code.
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const followUp = z.strictObject({
  worker: z.string().min(1),
  messageId: z.string().min(1),
  text: z.string(),
});
const batch = z.strictObject({
  revision: z.number().int().positive(),
  requestId: z.string(),
  previous: z.string(),
  assignment: z.number().int().positive(),
  inbox: followUp,
});
type Batch = z.infer<typeof batch>;
const frame = z.strictObject({ batch, digest: z.string() });
export type Frame = z.infer<typeof frame>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function readLedger(
  directory: string,
): Promise<{ frames: Frame[]; incompleteTail: boolean }> {
  const bytes = await readFile(join(directory, "ledger.jsonl"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const lines = bytes.split("\n");
  const incompleteTail = lines.pop() !== "";
  const frames: Frame[] = [];
  let previous = "";
  for (const line of lines) {
    const parsed = frame.parse(JSON.parse(line));
    if (
      parsed.digest !== digest(parsed.batch) ||
      parsed.batch.previous !== previous ||
      parsed.batch.revision !== frames.length + 1
    )
      throw new Error("Invalid committed ledger frame");
    frames.push(parsed);
    previous = parsed.digest;
  }
  return { frames, incompleteTail };
}

export async function claimLedger(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ownerPath = join(directory, "owner.json");
  const token = randomUUID();
  const owner = await open(ownerPath, "wx", 0o600);
  try {
    await owner.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname() }));
    await owner.sync();
  } finally {
    await owner.close();
  }
  async function accept(
    requestId: string,
    input: z.input<typeof followUp>,
    boundary?: (phase: "written" | "synced") => void,
  ): Promise<Frame> {
    const inbox = followUp.parse(input);
    const replay = await readLedger(directory);
    if (replay.incompleteTail) throw new Error("Incomplete tail requires explicit reconciliation");
    const previous = replay.frames.find((entry) => entry.batch.requestId === requestId);
    if (previous) {
      if (digest(previous.batch.inbox) !== digest(inbox))
        throw new Error("Request ID content conflict");
      return previous;
    }
    const message = replay.frames.find((entry) => entry.batch.inbox.messageId === inbox.messageId);
    if (message) throw new Error("Message ID already accepted with another request");
    const value: Batch = {
      revision: replay.frames.length + 1,
      requestId,
      previous: replay.frames.at(-1)?.digest ?? "",
      assignment:
        replay.frames.filter((entry) => entry.batch.inbox.worker === inbox.worker).length + 1,
      inbox,
    };
    const committed: Frame = { batch: value, digest: digest(value) };
    const log = await open(join(directory, "ledger.jsonl"), "a", 0o600);
    try {
      await log.writeFile(JSON.stringify(committed) + "\n");
      boundary?.("written");
      await log.sync();
      boundary?.("synced");
    } finally {
      await log.close();
    }
    if (process.platform !== "win32") {
      const folder = await open(directory, "r");
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
    }
    return committed;
  }
  let pending: Promise<void> = Promise.resolve();
  return {
    follow(
      requestId: string,
      input: z.input<typeof followUp>,
      boundary?: (phase: "written" | "synced") => void,
    ) {
      const operation = pending.then(() => accept(requestId, input, boundary));
      // Keep intake serialized; the caller still receives the operation's rejection.
      pending = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
    async close() {
      await pending;
      const current = z
        .strictObject({ token: z.string(), pid: z.number(), host: z.string() })
        .parse(JSON.parse(await readFile(ownerPath, "utf8")));
      if (current.token !== token) throw new Error("Owner changed; refusing release");
      await unlink(ownerPath);
    },
  };
}
