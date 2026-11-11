import { z } from "zod";
import {
  type BenchResult,
  type Budget,
  type BudgetConfiguration,
  type BudgetProfile,
  type CellSpec,
} from "./types.ts";

const apfsStorageSchema = z.object({
  status: z.literal("observed"),
  directory: z.string().min(1),
  filesystemType: z.string().regex(/^0x[1-9a-f][0-9a-f]*$/),
  blockSize: z.string().regex(/^[1-9][0-9]*$/),
  device: z.string().regex(/^[0-9]+$/),
  filesystemName: z.object({
    status: z.literal("observed"),
    method: z.literal("darwin-df-libxo-v1"),
    name: z.literal("apfs"),
    directory: z.string().min(1),
    device: z.string().regex(/^[0-9]+$/),
    deviceNode: z.string().regex(/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/),
    mountPoint: z.string().startsWith("/"),
  }),
});

export function selectBudgets(
  configuration: BudgetConfiguration,
  context: {
    ci: boolean;
    backend: CellSpec["backend"];
    platform: string;
    storage: unknown;
  },
): { profile: BudgetProfile; budgets: Budget[] } {
  if (!context.ci || context.backend !== "in-process") return { profile: "advisory", budgets: [] };
  const storage = apfsStorageSchema.safeParse(context.storage);
  const isDarwinApfs =
    context.platform === "darwin" &&
    storage.success &&
    storage.data.filesystemName.directory === storage.data.directory &&
    storage.data.filesystemName.device === storage.data.device;
  // Darwin assigns filesystem type numbers dynamically. Only the observed name
  // tied to this allocation selects the exception; unknown evidence stays strict.
  const overrides = isDarwinApfs ? configuration.darwinApfsOverrides : [];
  return {
    profile: isDarwinApfs ? "darwin-apfs-v1" : "default-v1",
    budgets: configuration.budgets.map((budget) => ({
      ...budget,
      max:
        overrides.find(
          (override) => override.scenario === budget.scenario && override.metric === budget.metric,
        )?.max ?? budget.max,
    })),
  };
}

export function metric(value: unknown, path: string): number | null {
  let current = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current) && current >= 0 ? current : null;
}
export function executionFailures(spec: CellSpec, result: BenchResult): string[] {
  const failures: string[] = [];
  const count = spec.scenario.tasks.length * spec.scenario.histories;
  const dependents =
    spec.scenario.tasks.filter((task) => task.after.length).length +
    spec.scenario.tasks.length * (spec.scenario.histories - 1);
  if (
    result.cellId !== spec.cellId ||
    result.scenario !== spec.scenario.name ||
    result.backend !== spec.backend ||
    result.provider !== spec.provider ||
    result.host !== spec.host
  )
    failures.push("Result identity differs from the allocated cell");
  if (
    result.status !== "completed" ||
    result.agents !== spec.scenario.tasks.length ||
    result.assignments !== count ||
    result.statuses.completed !== count ||
    Object.entries(result.statuses).some(([key, value]) => key !== "completed" && value !== 0)
  )
    failures.push("Every requested assignment must complete");
  if (!result.warmup.completed) failures.push("Warm-up did not complete");
  if (
    !result.usage.complete ||
    result.usage.expectedAttempts !== count ||
    result.usage.measuredAttempts !== count
  )
    failures.push("Started attempts lack complete observed usage");
  if (result.cleanup.runtime !== "closed" || !result.cleanup.leasesReleased)
    failures.push("Runtime cleanup or workspace release is unconfirmed");
  const samples: Array<[string, number]> = [
    ["spawnMs", count],
    ["setupMs", count],
    ["toolCallMs", count - dependents],
    ["dependentMs", dependents],
    ["dependentRequestMs", dependents],
    ["cleanupMs", count],
    ["notificationLagMs", count],
    ["restoreMs", count - spec.scenario.tasks.length],
  ];
  for (const [name, expected] of samples) {
    if (!expected) continue;
    if (metric(result, `${name}.n`) !== expected)
      failures.push(`${name} lacks complete ${expected}-assignment coverage`);
    for (const percentile of ["p50", "p95", "p99", "max"])
      if (metric(result, `${name}.${percentile}`) === null)
        failures.push(`${name}.${percentile} is missing or invalid`);
  }
  for (const name of [
    "peakRssMB",
    "memoryPerAgentMB",
    "cpuMs",
    "wallMs",
    "loopLagP95Ms",
    "loopLagP99Ms",
    "acceptanceMs.p50",
    "journalSyncMs.p50",
    "io.artifactBytesRead",
    "io.artifactBytesSubmitted",
    "io.journalBytes",
    "io.retainedBytes",
  ])
    if (metric(result, name) === null) failures.push(`${name} is missing or invalid`);
  if (!result.settledHeapMeasured || metric(result, "settledHeapDeltaMB") === null)
    failures.push("Settled heap requires an available garbage collector");
  const syncs = Object.values(result.profile.fsync);
  if (
    !syncs.length ||
    syncs.some(
      (sync) =>
        sync.attempts !== sync.completed ||
        sync.totalMs < sync.busyMs ||
        (sync.distinct?.n ?? 0) > sync.completed,
    )
  )
    failures.push("Fsync profiling has missing or unmatched operation coverage");
  const components = result.profile.components;
  if (!components) failures.push("Production component profiling is missing");
  else {
    for (const name of [
      "readyQueueMs",
      "outboxScanMs",
      "consumptionScanMs",
      "sessionValidationMs",
      "sessionRestoreMs",
    ] as const)
      if (!components[name]) failures.push(`${name} component profiling is missing`);
    if (
      components.consumptionEntries !== count ||
      components.sessionRestoreMs?.n !== spec.scenario.tasks.length
    )
      failures.push("Component profiling does not cover the retained histories and sessions");
    if (components.fingerprint.status !== "stable" || components.fingerprint.cleanup !== "stopped")
      failures.push("Fingerprint profiling changed content or left helper cleanup unconfirmed");
    if (!components.idle.resourcePlateau || components.idle.cleanup !== "closed")
      failures.push("Shared idle resources did not plateau with confirmed cleanup");
  }
  if (spec.backend !== "in-process") {
    if (
      !result.process ||
      result.process.startupMs?.n !== count ||
      result.process.childPeakRssMB?.n !== count ||
      Object.keys(result.process.loadedSamplesByAssignment).length !== count ||
      Object.values(result.process.loadedSamplesByAssignment).some((value) => value < 1)
    )
      failures.push("Process startup and loaded child RSS coverage must include every assignment");
  }
  if (result.observations.viewer !== spec.viewer)
    failures.push("Observed viewer attachment differs from the allocated cell");
  if (
    spec.viewer &&
    (!result.observations.viewer ||
      result.profile.renderRequests < 1 ||
      result.profile.navigationMs?.n !== 100)
  )
    failures.push("Attached viewer did not render and complete 100 measured navigation cycles");
  failures.push(...result.errors);
  return [...new Set(failures)];
}
export function overBudget(result: BenchResult, budgets: readonly Budget[], factor = 2): string[] {
  const failures: string[] = [];
  for (const budget of budgets.filter((entry) => entry.scenario === result.scenario)) {
    const value = metric(result, budget.metric);
    if (value === null) failures.push(`${budget.metric} is missing or invalid`);
    else if (value > factor * budget.max)
      failures.push(`${budget.metric}=${value.toFixed(3)} exceeds ${factor} × ${budget.max}`);
  }
  return failures;
}
export function comparison(
  previous: unknown,
  current: { provenance: Record<string, unknown> },
): { comparable: boolean; reasons: string[] } {
  if (
    !previous ||
    typeof previous !== "object" ||
    !("schemaVersion" in previous) ||
    previous.schemaVersion !== 1 ||
    !("measurement" in previous) ||
    previous.measurement !== "pinata-scripted-runtime-v1" ||
    !("status" in previous) ||
    previous.status !== "completed" ||
    !("provenance" in previous) ||
    !previous.provenance ||
    typeof previous.provenance !== "object"
  )
    return {
      comparable: false,
      reasons: ["The baseline is partial, failed, or from another measurement protocol"],
    };
  const reasons: string[] = [];
  const storage = (value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("status" in value) ||
      value.status !== "observed" ||
      !("filesystemType" in value) ||
      typeof value.filesystemType !== "string" ||
      !/^0x[1-9a-f][0-9a-f]*$/.test(value.filesystemType) ||
      !("blockSize" in value) ||
      typeof value.blockSize !== "string" ||
      !/^[1-9][0-9]*$/.test(value.blockSize)
    )
      return undefined;
    return { filesystemType: value.filesystemType, blockSize: value.blockSize };
  };
  const previousStorage = storage((previous.provenance as Record<string, unknown>).storage);
  const currentStorage = storage(current.provenance.storage);
  if (!previousStorage || !currentStorage)
    reasons.push("Storage filesystem provenance is missing or unavailable");
  else if (JSON.stringify(previousStorage) !== JSON.stringify(currentStorage))
    reasons.push("Baseline storage filesystem type or block size differs");
  for (const key of [
    "platform",
    "architecture",
    "cpu",
    "memory",
    "node",
    "piLauncher",
    "budgetProfile",
    "lockfile",
    "configuration",
    "workloads",
  ])
    if (
      JSON.stringify((previous.provenance as Record<string, unknown>)[key]) !==
      JSON.stringify(current.provenance[key])
    )
      reasons.push(`Baseline cohort differs in ${key}`);
  return { comparable: reasons.length === 0, reasons };
}
