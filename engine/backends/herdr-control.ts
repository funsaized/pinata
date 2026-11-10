import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { ArtifactPort, CleanupReceipt } from "../contracts/index.ts";
import {
  launchSupervised,
  SupervisorLaunchError,
  type SupervisedProcess,
} from "./supervision/index.ts";
import { readEvidence } from "./supervision/evidence.ts";

export type HerdrControl = {
  request(args: string[], signal: AbortSignal): Promise<unknown>;
  receipts(): CleanupReceipt[];
};
export type HerdrCliOptions = { bin?: string; session?: string };
export class HerdrCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrCommandError";
    this.code = code;
  }
}

export function insideHerdr(): boolean {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_SOCKET_PATH);
}

export function createHerdrControl(
  options: HerdrCliOptions & {
    cwd: string;
    directory: string;
    ownerEpoch: string;
    artifacts: ArtifactPort;
    nodeCommand?: string;
  },
): HerdrControl {
  const receipts: CleanupReceipt[] = [];
  return {
    receipts: () => structuredClone(receipts),
    async request(args, signal) {
      const directory = join(options.directory, "herdr-control", randomUUID());
      let handle: SupervisedProcess | undefined;
      let value: unknown;
      let failure: unknown;
      const retainCleanup = async (cleanup: CleanupReceipt): Promise<void> => {
        const evidence = [];
        for (const reference of cleanup.evidence)
          evidence.push(await options.artifacts.put(await readEvidence(directory, reference)));
        receipts.push({ ...cleanup, evidence });
      };
      try {
        handle = await launchSupervised({
          directory,
          command: options.bin ?? "herdr",
          args: [...(options.session ? ["--session", options.session] : []), ...args],
          cwd: options.cwd,
          ownerEpoch: options.ownerEpoch,
          lifetime: "attached",
          nodeCommand: options.nodeCommand,
          signal,
          async onEnrolled(identity) {
            await options.artifacts.put(Buffer.from(JSON.stringify(identity)));
          },
        });
        const outcome = await Promise.race([
          handle.exit,
          handle.closed.then(() => {
            throw new Error("Herdr command guardian closed without an exit");
          }),
        ]);
        const lengths = await handle.outputDrained;
        const active = handle;
        if (lengths.stdout > 16 * 1024 * 1024 || lengths.stderr > 16 * 1024 * 1024)
          throw new HerdrCommandError(
            "too_large",
            "Herdr command output exceeded its transport limit",
          );
        const read = async (stream: "stdout" | "stderr", length: number): Promise<string> => {
          const chunks: Buffer[] = [];
          let offset = 0;
          while (offset < length) {
            const part = await active.readOutput({
              stream,
              offset,
              maxBytes: Math.min(length - offset, 1024 * 1024),
            });
            if (!part.bytes.length)
              throw new Error("Herdr output is shorter than its durable receipt");
            chunks.push(part.bytes);
            offset = part.nextOffset;
          }
          return Buffer.concat(chunks).toString("utf8");
        };
        const stdout = await read("stdout", lengths.stdout);
        if (outcome.code !== 0) {
          const stderr = await read("stderr", lengths.stderr);
          const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(
            (() => {
              try {
                return JSON.parse(stderr);
              } catch {
                return undefined;
              }
            })(),
          );
          throw new HerdrCommandError(
            parsed.success ? parsed.data.error.code : "command_failed",
            `Herdr ${args.slice(0, 2).join(" ")} failed`,
          );
        }
        if (args[0] === "pane" && args[1] === "read") value = stdout;
        else
          value = stdout.trim()
            ? z
                .object({ id: z.string(), result: z.unknown(), error: z.never().optional() })
                .parse(JSON.parse(stdout)).result
            : {};
      } catch (error) {
        if (error instanceof SupervisorLaunchError) await retainCleanup(error.cleanup);
        failure = error;
      }
      if (handle) {
        try {
          const cleanup = await handle.stop({ reason: "Herdr control command completed" });
          await retainCleanup(cleanup);
          if (cleanup.status !== "stopped")
            throw new HerdrCommandError(
              "cleanup_unconfirmed",
              "Herdr control command cleanup is unconfirmed",
            );
        } catch (error) {
          throw new AggregateError(
            failure ? [failure, error] : [error],
            "Herdr command cleanup failed",
          );
        }
      }
      if (failure) throw failure;
      return value;
    },
  };
}
