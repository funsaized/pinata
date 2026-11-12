import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  BackendStartFailure,
  inboxMessageSchema,
  type BackendHandle,
  type BackendLaunch,
  type BackendObservation,
} from "../contracts/index.ts";
import { supervisedSessionProcesses } from "../agent/processes.ts";
import { InProcessBackend } from "./in-process.ts";
import { loadBootstrap } from "../definitions/typed.ts";
import { readLoadout } from "../definitions/resources.ts";
import { fileChildClient } from "./delegation-transport.ts";
import {
  numberedPath,
  processArtifacts,
  processBriefSchema,
  processCommandSchema,
  processManifestSchema,
  processEnrollmentSchema,
  processObservationSchema,
  processOutcomeSchema,
  processReadySchema,
  processResponseSchema,
  readRecord,
  writeRecord,
  type ProcessResponse,
  type ProcessManifest,
} from "./process-transport.ts";
import { ProcessSignals } from "./process-signals.ts";

async function runWorker(directory: string): Promise<void> {
  const manifest = await readRecord(join(directory, "manifest.json"), processManifestSchema);
  if (!manifest) throw new Error("Worker launch manifest is missing");
  const enrollment = await readRecord(join(directory, "enrollment.json"), processEnrollmentSchema);
  if (!enrollment) throw new Error("Worker supervisor enrollment is missing");
  const signals = new ProcessSignals(enrollment.supervisor, "worker");
  try {
    await signals.connect();
    await runSession(directory, manifest, signals);
  } finally {
    signals.close();
  }
}

async function runSession(
  directory: string,
  manifest: ProcessManifest,
  signals: ProcessSignals,
): Promise<void> {
  const artifacts = processArtifacts(manifest.launch.storeDirectory);
  const initialMessages = z
    .array(inboxMessageSchema)
    .parse(
      JSON.parse(
        Buffer.from(await artifacts.read(manifest.launch.initialMessages)).toString("utf8"),
      ),
    );
  const brief = processBriefSchema.parse(
    JSON.parse(Buffer.from(await artifacts.read(manifest.launch.brief)).toString("utf8")),
  );
  const launch: BackendLaunch = {
    ...manifest.launch,
    initialMessages,
    brief,
    artifacts,
    worker: { ...manifest.launch.worker, lifetime: "attached" },
  };
  let ordinal = 1;
  let observations = Promise.resolve();
  const observe = (observation: BackendObservation): Promise<void> => {
    if (observation.kind === "enrolled") return Promise.resolve();
    if (observation.kind === "activity") {
      signals.publishActivity({ ...observation, source: manifest.identity.id });
      return Promise.resolve();
    }
    const record = processObservationSchema.parse({
      schemaVersion: 1,
      sourceId: manifest.identity.id,
      ordinal: ++ordinal,
      observation,
    });
    observations = observations.then(async () => {
      await writeRecord(numberedPath(directory, "observations", record.ordinal), record);
      signals.notify();
    });
    return observations;
  };
  let handle: BackendHandle;
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(manifest.options.agentDir, "auth.json"),
      modelsPath: join(manifest.options.agentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const loadout = launch.worker.loadout
      ? await readLoadout(launch.worker.loadout, artifacts)
      : undefined;
    const bootstrap = manifest.options.bootstrapModule
      ? await loadBootstrap(
          manifest.options.bootstrapModule,
          loadout?.trusted ? loadout.source : undefined,
        )
      : undefined;
    await bootstrap?.configureModelRuntime?.(modelRuntime, manifest);
    await modelRuntime.refresh({ allowNetwork: false });
    const backend = new InProcessBackend({
      modelRuntime: async () => modelRuntime,
      bootstrap,
      agentDir: manifest.options.agentDir,
      memoryProject: manifest.options.memoryProject,
      codemode: manifest.options.codemode,
      extensions: manifest.options.extensions,
      ...(launch.worker.grants.delegation.maxDepth
        ? { children: () => fileChildClient(directory, signals) }
        : {}),
      createProcesses: (request) =>
        supervisedSessionProcesses(request, {
          nodeCommand: manifest.options.nodeCommand,
        }),
    });
    handle = await backend.start(launch, observe, new AbortController().signal);
    await writeRecord(join(directory, "ready.json"), processReadySchema.parse({ status: "ready" }));
    signals.notify();
  } catch (error) {
    await writeRecord(
      join(directory, "ready.json"),
      processReadySchema.parse({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        cleanup:
          error instanceof BackendStartFailure
            ? error.cleanup
            : {
                status: "stopped",
                ownerEpoch: launch.ownerEpoch,
                identities: [],
                evidence: [],
              },
      }),
    );
    signals.notify();
    await signals.flush();
    return;
  }
  const outcome = handle.done.then(async (value) => {
    await observations;
    await writeRecord(
      join(directory, "outcome.json"),
      processOutcomeSchema.parse({
        schemaVersion: 1,
        throughOrdinal: ordinal,
        outcome: value,
      }),
    );
    signals.notify();
    await signals.flush();
  });
  // A failed durable output is not converted to a successful worker response.
  let outcomeFailure: unknown;
  void outcome.catch((error: unknown) => {
    outcomeFailure = error;
    signals.wake();
  });
  let runtimeOwnerEpoch = manifest.launch.ownerEpoch;
  let commandOrdinal = 1;
  while (true) {
    const version = signals.version;
    if (outcomeFailure) throw outcomeFailure;
    const command = await readRecord(
      numberedPath(directory, "commands", commandOrdinal),
      processCommandSchema,
    );
    if (!command) {
      await signals.wait(version);
      continue;
    }
    if (command.ordinal !== commandOrdinal) throw new Error("Worker command ordinal mismatch");
    let response: ProcessResponse;
    let stopping = false;
    try {
      if (command.command.action !== "attach" && command.runtimeOwnerEpoch !== runtimeOwnerEpoch)
        throw new Error("Worker command belongs to a superseded runtime owner");
      switch (command.command.action) {
        case "attach":
          runtimeOwnerEpoch = command.command.runtimeOwnerEpoch;
          response = { status: "ok", id: command.id, ordinal: commandOrdinal, runtimeOwnerEpoch };
          break;
        case "input":
          response = {
            status: "ok",
            id: command.id,
            ordinal: commandOrdinal,
            receipt: await handle.input(command.command.message),
          };
          break;
        case "checkpoint":
          response = {
            status: "ok",
            id: command.id,
            ordinal: commandOrdinal,
            checkpoint: await handle.checkpoint(),
          };
          break;
        case "stop":
          response = {
            status: "ok",
            id: command.id,
            ordinal: commandOrdinal,
            stopped: await handle.stop(command.command.reason),
          };
          await outcome;
          stopping = true;
          break;
      }
    } catch (error) {
      response = {
        status: "error",
        id: command.id,
        ordinal: commandOrdinal,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await observations;
    await writeRecord(
      numberedPath(directory, "responses", commandOrdinal),
      processResponseSchema.parse(response),
    );
    signals.notify();
    commandOrdinal++;
    if (stopping) {
      await signals.flush();
      return;
    }
  }
}

const directory = process.argv[2];
if (!directory) throw new Error("Worker transport directory is required");
await runWorker(directory).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
