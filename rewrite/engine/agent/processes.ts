import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  canonicalJson,
  digestValue,
  type BackendLaunch,
  type CleanupReceipt,
} from "../contracts/index.ts";
import {
  launchSupervised,
  SupervisorLaunchError,
  type SupervisedProcess,
} from "../backends/supervision/index.ts";
import { readEvidence } from "../backends/supervision/evidence.ts";
import type { SessionProcesses } from "../backends/in-process.ts";

export function supervisedSessionProcesses(
  launch: BackendLaunch,
  options: {
    nodeCommand?: string;
    bashCommand?: string;
    powershellCommand?: string;
  } = {},
): SessionProcesses {
  const handles = new Set<SupervisedProcess>();
  const starting = new Set<Promise<SupervisedProcess>>();
  const controllers = new Set<AbortController>();
  const launchFailures: CleanupReceipt[] = [];
  let closing = false;
  let stopped: Promise<CleanupReceipt> | undefined;

  const importEvidence = async (
    directory: string,
    cleanup: CleanupReceipt,
  ): Promise<CleanupReceipt> => {
    const evidence = await Promise.all(
      cleanup.evidence.map(async (ref) => launch.artifacts.put(await readEvidence(directory, ref))),
    );
    return { ...cleanup, evidence };
  };

  const operation = (executable: string, args: (command: string) => string[]): BashOperations => ({
    async exec(command, cwd, request) {
      if (closing) throw new Error("The worker process scope is stopping");
      request.signal?.throwIfAborted();
      const controller = new AbortController();
      controllers.add(controller);
      const abort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", abort, { once: true });
      const timeout =
        request.timeout === undefined
          ? undefined
          : setTimeout(
              () => controller.abort(new Error("Requested shell tool timeout elapsed")),
              request.timeout * 1000,
            );
      const directory = join(
        launch.storeDirectory,
        "processes",
        digestValue(launch.attemptId),
        randomUUID(),
      );
      const env = Object.fromEntries(
        Object.entries(request.env ?? process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      env.PINATA_AGENT = "1";
      delete env.PINATA_AGENT_OPTIONS;
      delete env.PINATA_AGENT_OPTIONS_FILE;
      const spawning = launchSupervised({
        directory,
        command: executable,
        args: args(command),
        cwd,
        env,
        ownerEpoch: launch.ownerEpoch,
        lifetime: "attached",
        nodeCommand: options.nodeCommand,
        signal: controller.signal,
        async onEnrolled(identity) {
          await launch.artifacts.put(
            Buffer.from(canonicalJson({ schemaVersion: 1, attemptId: launch.attemptId, identity })),
          );
        },
        onEvent(event) {
          if (event.kind === "output") request.onData(Buffer.from(event.data, "base64"));
        },
      }).then(
        (handle) => {
          handles.add(handle);
          return handle;
        },
        async (error: unknown) => {
          if (error instanceof SupervisorLaunchError)
            launchFailures.push(await importEvidence(directory, error.cleanup));
          else
            launchFailures.push({
              status: "unconfirmed",
              ownerEpoch: launch.ownerEpoch,
              identities: [],
              evidence: [],
              reasons: [error instanceof Error ? error.message : String(error)],
            });
          throw error;
        },
      );
      starting.add(spawning);
      try {
        const handle = await spawning;
        const outcome = await Promise.race([
          handle.exit,
          handle.closed.then(() => {
            throw new Error("The shell guardian connection ended without a payload outcome");
          }),
        ]);
        await handle.outputDrained;
        controller.signal.throwIfAborted();
        return { exitCode: outcome.code ?? (outcome.signal ? 128 : null) };
      } finally {
        starting.delete(spawning);
        controllers.delete(controller);
        request.signal?.removeEventListener("abort", abort);
        if (timeout) clearTimeout(timeout);
      }
    },
  });

  return {
    bash: operation(options.bashCommand ?? "bash", (command) => ["-lc", command]),
    ...(options.powershellCommand
      ? {
          powershell: operation(options.powershellCommand, (command) => [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
          ]),
        }
      : {}),
    stop() {
      if (stopped) return stopped;
      closing = true;
      for (const controller of controllers)
        controller.abort(new Error("Worker process scope stopped"));
      stopped = (async (): Promise<CleanupReceipt> => {
        // Launch failures are retained by exec(); this wait only ensures every
        // registered spawn has reached a handle or a typed cleanup result.
        await Promise.allSettled(starting);
        const receipts = [...launchFailures];
        for (const handle of handles) {
          try {
            receipts.push(
              await importEvidence(
                handle.identity.directory,
                await handle.stop({ reason: "Worker cleanup" }),
              ),
            );
          } catch (error) {
            receipts.push({
              status: "unconfirmed",
              ownerEpoch: launch.ownerEpoch,
              identities: [handle.identity.id],
              evidence: [],
              reasons: [error instanceof Error ? error.message : String(error)],
            });
          }
        }
        const evidence = receipts.flatMap((receipt) => receipt.evidence);
        const identities = receipts.flatMap((receipt) => receipt.identities);
        const reasons = receipts.flatMap((receipt) =>
          receipt.status === "unconfirmed" ? receipt.reasons : [],
        );
        return reasons.length
          ? { status: "unconfirmed", ownerEpoch: launch.ownerEpoch, identities, evidence, reasons }
          : { status: "stopped", ownerEpoch: launch.ownerEpoch, identities, evidence };
      })();
      return stopped;
    },
  };
}
