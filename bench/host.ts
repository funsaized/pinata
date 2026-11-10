import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { publishImmutable } from "../engine/storage/io.ts";
import { inspectStore } from "../engine/storage/journal.ts";
import { initialState, reduce } from "../engine/core/state.ts";
import { runCell } from "./engine.ts";
import { benchResultSchema, cellSpecSchema, type BenchResult, type CellSpec } from "./types.ts";

export async function failedResult(spec: CellSpec, error: unknown): Promise<BenchResult> {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const result: BenchResult = {
    schemaVersion: 3,
    cellId: spec.cellId,
    scenario: spec.scenario.name,
    backend: spec.backend,
    provider: spec.provider,
    host: spec.host,
    runtime: {
      node: process.version,
      ...(process.versions.bun ? { bun: process.versions.bun } : {}),
      pi: "unavailable",
      platform: process.platform,
      architecture: process.arch,
    },
    status: message.includes("unavailable:") ? "unavailable" : "failed",
    agents: spec.scenario.tasks.length,
    assignments: spec.scenario.tasks.length * spec.scenario.histories,
    statuses: {},
    usage: { expectedAttempts: 0, measuredAttempts: 0, complete: false },
    warmup: { completed: false, milliseconds: 0 },
    spawnMs: null,
    setupMs: null,
    toolCallMs: null,
    dependentMs: null,
    dependentRequestMs: null,
    acceptanceMs: null,
    journalSyncMs: null,
    artifactSyncMs: null,
    queueMs: { fifo: null, dependency: null, capacity: null },
    restoreMs: null,
    cleanupMs: null,
    notificationLagMs: null,
    loopLagP95Ms: null,
    loopLagP99Ms: null,
    memoryPerAgentMB: null,
    peakRssMB: null,
    settledHeapDeltaMB: null,
    settledHeapMeasured: false,
    cpuMs: 0,
    wallMs: 0,
    samples: {},
    process: null,
    io: {
      artifactBytesRead: 0,
      artifactBytesSubmitted: 0,
      journalBytes: 0,
      retainedBytes: 0,
      osReadBytes: null,
      osWriteBytes: null,
      coverage: "Unavailable after an interrupted host; retained run artifacts are authoritative.",
    },
    profile: {
      reducerMs: 0,
      acceptanceReducerMs: 0,
      consumptionReducerMs: 0,
      graphValidationMs: 0,
      fullLogDeliveryMs: 0,
      projectionMs: 0,
      renderMs: 0,
      renderRequests: 0,
      navigationMs: null,
      journalFrames: 0,
      fsync: {},
      components: null,
    },
    observations: {
      requestedMode: spec.mode,
      viewer: spec.viewer,
      activityEvents: 0,
      committedEvents: 0,
      painted: false,
    },
    cleanup: { runtime: "unconfirmed", leasesReleased: false },
    errors: [message],
  };
  try {
    const directory = join(spec.directory, "runs", spec.scenario.name);
    const store = await inspectStore(directory);
    let state = initialState(store.manifest.run);
    for (const frame of store.frames)
      state = reduce(state, frame.record.transition, frame.record.revision);
    for (const assignment of Object.values(state.assignments)) {
      const phase =
        assignment.execution.phase === "ended"
          ? assignment.execution.reason
          : assignment.execution.phase;
      result.statuses[phase] = (result.statuses[phase] ?? 0) + 1;
    }
    result.usage.expectedAttempts = Object.keys(state.attempts).length;
    result.usage.measuredAttempts = new Set(
      Object.values(state.results).flatMap((entry) =>
        entry.result.usage.observations.map((observation) => observation.attempt),
      ),
    ).size;
    result.profile.journalFrames = store.frames.length;
    result.errors.push(
      `Retained ${Object.keys(state.assignments).length} accepted assignments, ${result.usage.expectedAttempts} started attempts and ${Object.keys(state.results).length} settled results in ${directory}`,
    );
  } catch (cause) {
    const known = await readdir(spec.directory).catch(() => []);
    result.errors.push(
      `Partial run inspection unavailable: ${cause instanceof Error ? cause.message : String(cause)}. Retained entries: ${known.join(", ")}`,
    );
  }
  return result;
}
export async function writeResult(spec: CellSpec, result: BenchResult): Promise<void> {
  await publishImmutable(
    spec.output,
    Buffer.from(JSON.stringify(benchResultSchema.parse(result), null, 2)),
    "benchmark-result",
  );
}
export async function main(path: string): Promise<void> {
  const spec = cellSpecSchema.parse(JSON.parse(await readFile(path, "utf8")));
  let result: BenchResult;
  try {
    result = await runCell(spec);
  } catch (error) {
    result = await failedResult(spec, error);
  }
  await writeResult(spec, result);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv[2]);
