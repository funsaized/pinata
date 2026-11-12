import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { canonicalJson, commandReceiptSchema, DomainError } from "../contracts/index.ts";
import {
  childQueryResultSchema,
  childWaitResultSchema,
  type ChildPort,
} from "../contracts/delegation.ts";
import { isMissing } from "../storage/io.ts";
import { numberedPath, readRecord, writeRecord } from "./process-transport.ts";
import type { TransportSignals } from "./process-signals.ts";

const requestSchema = z.strictObject({
  id: z.uuid(),
  ordinal: z.number().int().positive(),
  method: z.enum(["execute", "query", "wait"]),
  input: z.unknown(),
});
const responseSchema = z.discriminatedUnion("status", [
  z.strictObject({ id: z.uuid(), status: z.literal("ok"), result: z.unknown() }),
  z.strictObject({ id: z.uuid(), status: z.literal("error"), message: z.string() }),
]);
const cancelSchema = z.strictObject({ id: z.uuid() });
const maxBytes = 64 * 1024 * 1024;

async function boundedRecord<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    if ((await lstat(path)).size > maxBytes)
      throw new DomainError("invalid_input", "Child transport record exceeds the message limit");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return readRecord(path, schema);
}

export function fileChildClient(directory: string, signals?: TransportSignals): ChildPort {
  let ordinal = 0;
  let publication = Promise.resolve();
  async function request(
    method: "execute" | "query" | "wait",
    input: unknown,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const record = requestSchema.parse({ id: randomUUID(), ordinal: ++ordinal, method, input });
    if (Buffer.byteLength(canonicalJson(record)) > maxBytes / 2)
      throw new DomainError("invalid_input", "Child request exceeds the message limit");
    const pending = publication.then(() =>
      writeRecord(numberedPath(directory, "child-requests", record.ordinal), record),
    );
    publication = pending;
    await pending;
    signals?.notify();
    while (true) {
      const version = signals?.version ?? 0;
      if (signal?.aborted) {
        await writeRecord(numberedPath(directory, "child-cancel", record.ordinal), {
          id: record.id,
        });
        signals?.notify();
        signal.throwIfAborted();
      }
      const reply = await boundedRecord(
        numberedPath(directory, "child-replies", record.ordinal),
        responseSchema,
      );
      if (reply) {
        if (reply.id !== record.id) throw new Error("Child reply does not match its request");
        if (reply.status === "error") throw new Error(reply.message);
        return reply.result;
      }
      // The original process can outlive an owner. A new owner resumes these
      // same requests; the runtime request ID prevents a second accepted command.
      if (signals) {
        // Wake promptly on cancellation so its durable record is published above.
        const abort = () => signals.wake();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (!signal?.aborted) await signals.wait(version);
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      } else await delay(20);
    }
  }
  return {
    execute: async (input, signal) =>
      commandReceiptSchema.parse(await request("execute", input, signal)),
    query: async (input, signal) =>
      childQueryResultSchema.parse(await request("query", input, signal)),
    wait: async (input, signal) =>
      childWaitResultSchema.parse(await request("wait", input, signal)),
  };
}

export function serveFileChildren(
  directory: string,
  port: ChildPort,
  signals?: TransportSignals,
): { close(): Promise<void>; done: Promise<void> } {
  let closed = false;
  let ordinal = 1;
  let failure: unknown;
  const pending = new Map<
    number,
    { id: string; controller: AbortController; promise: Promise<void> }
  >();
  const done = (async () => {
    while (!closed) {
      const version = signals?.version ?? 0;
      if (failure) throw failure;
      for (const [index, entry] of pending) {
        const cancelled = await boundedRecord(
          numberedPath(directory, "child-cancel", index),
          cancelSchema,
        );
        if (cancelled?.id === entry.id) entry.controller.abort();
      }
      const record =
        pending.size < 32
          ? await boundedRecord(numberedPath(directory, "child-requests", ordinal), requestSchema)
          : undefined;
      if (!record) {
        if (signals) await signals.wait(version);
        else await delay(20);
        continue;
      }
      if (record.ordinal !== ordinal) throw new Error("Child request ordinal mismatch");
      const index = ordinal++;
      const responsePath = numberedPath(directory, "child-replies", index);
      const prior = await boundedRecord(responsePath, responseSchema);
      if (prior) {
        if (prior.id !== record.id) throw new Error("Retained child reply identity mismatch");
        continue;
      }
      const controller = new AbortController();
      const operation = (async () => {
        let reply: z.infer<typeof responseSchema>;
        try {
          const result =
            record.method === "wait"
              ? await port.wait(record.input, controller.signal)
              : await port[record.method](record.input);
          reply = { id: record.id, status: "ok", result };
          if (Buffer.byteLength(canonicalJson(reply)) > maxBytes / 2)
            throw new Error(
              "Child reply exceeds the message limit; page the requested conversation",
            );
        } catch (error) {
          reply = {
            id: record.id,
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        if (!closed) {
          await writeRecord(responsePath, reply);
          signals?.notify();
        }
      })();
      pending.set(index, { id: record.id, controller, promise: operation });
      void operation.then(
        () => {
          pending.delete(index);
          signals?.wake();
        },
        (error: unknown) => {
          failure = error;
          signals?.wake();
        },
      );
    }
  })();
  // Failure is observed by ProcessHandle along with its worker observations.
  void done.catch(() => {});
  return {
    done,
    async close() {
      closed = true;
      signals?.wake();
      for (const entry of pending.values()) entry.controller.abort();
      await done;
      await Promise.all([...pending.values()].map((entry) => entry.promise));
    },
  };
}
