import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
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
import {
  numberedPath,
  processArtifacts,
  processBriefSchema,
  processCommandSchema,
  processManifestSchema,
  processObservationSchema,
  processOutcomeSchema,
  processReadySchema,
  processResponseSchema,
  readRecord,
  writeRecord,
  type ProcessResponse,
} from "./process-transport.ts";

async function runWorker(directory: string): Promise<void> {
  const manifest = await readRecord(join(directory, "manifest.json"), processManifestSchema);
  if (!manifest) throw new Error("Worker launch manifest is missing");
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
    const record = processObservationSchema.parse({
      schemaVersion: 1,
      sourceId: manifest.identity.id,
      ordinal: ++ordinal,
      observation,
    });
    observations = observations.then(() =>
      writeRecord(numberedPath(directory, "observations", record.ordinal), record),
    );
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
    if (manifest.options.bootstrapModule) {
      const bootstrap: unknown = await import(pathToFileURL(manifest.options.bootstrapModule).href);
      if (
        !bootstrap ||
        typeof bootstrap !== "object" ||
        !("configureModelRuntime" in bootstrap) ||
        typeof bootstrap.configureModelRuntime !== "function"
      )
        throw new Error("Explicit worker bootstrap must export configureModelRuntime");
      await bootstrap.configureModelRuntime(modelRuntime, manifest);
    }
    await modelRuntime.refresh({ allowNetwork: false });
    const backend = new InProcessBackend({
      modelRuntime: async () => modelRuntime,
      agentDir: manifest.options.agentDir,
      codemode: manifest.options.codemode,
      extensions: manifest.options.extensions,
      createProcesses: (request) =>
        supervisedSessionProcesses(request, {
          nodeCommand: manifest.options.nodeCommand,
        }),
    });
    handle = await backend.start(launch, observe, new AbortController().signal);
    await writeRecord(join(directory, "ready.json"), processReadySchema.parse({ status: "ready" }));
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
  });
  // A failed durable output is not converted to a successful worker response.
  let outcomeFailure: unknown;
  void outcome.catch((error: unknown) => {
    outcomeFailure = error;
  });
  let runtimeOwnerEpoch = manifest.launch.ownerEpoch;
  let commandOrdinal = 1;
  while (true) {
    if (outcomeFailure) throw outcomeFailure;
    const command = await readRecord(
      numberedPath(directory, "commands", commandOrdinal),
      processCommandSchema,
    );
    if (!command) {
      await delay(20);
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
    commandOrdinal++;
    if (stopping) return;
  }
}

const directory = process.argv[2];
if (!directory) throw new Error("Worker transport directory is required");
await runWorker(directory).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
