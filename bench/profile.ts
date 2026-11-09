import { mkdir, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { loadSkills, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  assignmentKey,
  canonicalJson,
  workspacePlanSchema,
  type CoreState,
} from "../engine/contracts/index.ts";
import { openConversation, validateConversation } from "../engine/agent/conversation.ts";
import { processArtifacts } from "../engine/backends/process-transport.ts";
import { freezeSkills, materializeSkills } from "../engine/definitions/resources.ts";
import {
  completionMessageType,
  consumedNoticeIds,
  noticeMarker,
} from "../engine/pi/notifications.ts";
import { captureManifest } from "../engine/workspace/capture.ts";
import { GitCommands } from "../engine/workspace/git.ts";
import { collectGarbage, mb, now, stat } from "./metrics.ts";
import type { CellSpec, ComponentProfile, IdleSample } from "./types.ts";

const executeFile = promisify(execFile);
let hasRuntimeInventory: boolean | undefined;
async function resources(): Promise<{
  counts: Record<string, number>;
  coverage: IdleSample["coverage"];
}> {
  if (hasRuntimeInventory === undefined) {
    const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const timer = setTimeout(() => {}, 10_000);
    try {
      hasRuntimeInventory =
        process.getActiveResourcesInfo().filter((name) => name === "Timeout").length > before;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!hasRuntimeInventory) {
    const count =
      process.platform === "win32"
        ? Number(
            (
              await executeFile(
                "powershell",
                [
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  `(Get-Process -Id ${process.pid} -ErrorAction Stop).HandleCount`,
                ],
                { timeout: 2000 },
              )
            ).stdout.trim(),
          )
        : (await readdir(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd")).length;
    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error("Host descriptor inventory is unavailable");
    return { counts: { OsDescriptor: count }, coverage: "os-descriptors" };
  }
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo().sort())
    counts[name] = (counts[name] ?? 0) + 1;
  return { counts, coverage: "runtime-active-resources" };
}

export async function sampleIdle(cycle: number): Promise<IdleSample> {
  // Settlement precedes writer-release completion. Wait for an observed stable
  // resource count, without treating an elapsed grace period as cleanup proof.
  let previous = "";
  let equal = 0;
  let observed: Record<string, number> = {};
  let coverage: IdleSample["coverage"] = "runtime-active-resources";
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(25);
    await nextTurn();
    const inventory = await resources();
    observed = inventory.counts;
    coverage = inventory.coverage;
    const current = canonicalJson(observed);
    equal = current === previous ? equal + 1 : 0;
    previous = current;
    if (equal >= 2) break;
  }
  const collected = collectGarbage();
  const memory = process.memoryUsage();
  return {
    cycle,
    stable: equal >= 2,
    resources: observed,
    coverage,
    heapUsedMB: collected ? mb(memory.heapUsed) : null,
    rssMB: mb(memory.rss),
  };
}

export function resourcePlateau(samples: readonly IdleSample[]): boolean {
  const retained = samples.slice(1);
  return (
    retained.length >= 3 &&
    retained.every(
      (sample) =>
        sample.stable &&
        sample.coverage === retained[0].coverage &&
        canonicalJson(sample.resources) === canonicalJson(retained[0].resources),
    )
  );
}

// These independent passes call production implementations after the timed
// workload closes. They neither contribute to startup budgets nor fabricate work.
export async function profileComponents(options: {
  spec: CellSpec;
  directory: string;
  state: CoreState;
  repository: string;
  agentDir: string;
  readyQueue: number[];
  outboxScans: number[];
  idle: ComponentProfile["idle"];
}): Promise<ComponentProfile> {
  const { spec, state } = options;
  const directory = join(spec.directory, "profiles");
  await mkdir(directory, { recursive: true });
  const retained = processArtifacts(options.directory);
  const artifacts = processArtifacts(directory);
  const workers = Object.values(state.workers);
  if (!workers.length) throw new Error("Component profiling needs retained workers");

  const parent = SessionManager.inMemory(options.repository);
  const notices = Object.entries(state.outbox);
  const messages: string[] = [];
  for (const [id, notice] of notices) {
    const result = state.results[assignmentKey(notice.ref)].result;
    const content = `${result.ref.worker}/${result.ref.assignment}: ${result.summary}\n${noticeMarker(id)}`;
    parent.appendCustomMessageEntry(completionMessageType, content, true, { id });
    messages.push(content);
  }
  const branch = parent.getBranch();
  // Model the normal retained-history case: the current payload carries the
  // latest worker completions; older saved notices remain on the branch.
  const payload = {
    messages: messages.slice(-workers.length).map((content) => ({ role: "user", content })),
  };
  const consumptionScan: number[] = [];
  for (let pass = 0; pass < 5; pass++) {
    const before = now();
    const consumed = consumedNoticeIds(branch, state.outbox, payload);
    consumptionScan.push(now() - before);
    if (consumed.length !== Math.min(workers.length, notices.length))
      throw new Error("Production notice-consumption scan did not match the retained payload");
  }
  await writeFile(
    join(directory, "consumption-input.json"),
    canonicalJson({ branch, outbox: state.outbox, payload }),
  );

  const validation: number[] = [];
  const restoration: number[] = [];
  let sessionEntries = 0;
  for (const worker of workers) {
    const checkpoint = state.sessions[worker.id];
    if (!checkpoint || checkpoint.format !== "pi")
      throw new Error("Session profiling requires an actual retained Pi checkpoint");
    const bytes = await retained.read(checkpoint.artifact);
    const start = now();
    sessionEntries += validateConversation(bytes).entries;
    validation.push(now() - start);
    const ref = { run: state.run, worker: worker.id, assignment: state.latest[worker.id] + 1 };
    const before = now();
    const restored = await openConversation({
      ref,
      worker,
      attemptId: `${assignmentKey(ref)}/profile`,
      ownerEpoch: spec.cellId,
      storeDirectory: join(directory, "restore"),
      artifacts: retained,
      cwd: options.repository,
      continuation: checkpoint,
      initialMessages: [],
      brief: { task: "Restore profile only", context: [], dependencies: [] },
    });
    restoration.push(now() - before);
    if (restored.getLeafId() !== checkpoint.branch)
      throw new Error("Restore profiling changed the saved branch");
  }

  const selected = join(directory, "selected-skill");
  await mkdir(selected);
  await writeFile(
    join(selected, "SKILL.md"),
    "---\nname: bench-profile\ndescription: Deterministic selected resource for runtime profiling.\n---\nRead the accompanying resource when requested.\n",
  );
  await writeFile(
    join(selected, "resource.txt"),
    "A selected resource does not grant tool capabilities.\n".repeat(100),
  );
  let before = now();
  const skills = await freezeSkills([selected], {
    cwd: options.repository,
    agentDir: options.agentDir,
    artifacts,
  });
  const freezeMs = now() - before;
  before = now();
  const skillPaths = await materializeSkills(skills, artifacts, join(directory, "materialized"));
  const materializeMs = now() - before;
  before = now();
  const loaded = loadSkills({
    cwd: options.repository,
    agentDir: options.agentDir,
    skillPaths,
    includeDefaults: false,
  });
  const loadMs = now() - before;
  if (
    loaded.diagnostics.length ||
    loaded.skills.length !== 1 ||
    loaded.skills[0].name !== "bench-profile"
  )
    throw new Error("Selected skill profiling did not load the exact explicit resource");

  const worker = workers[0];
  const plan = worker.workspacePlan
    ? workspacePlanSchema.parse(
        JSON.parse(Buffer.from(await retained.read(worker.workspacePlan)).toString("utf8")),
      )
    : undefined;
  const root = plan?.destination ?? options.repository;
  const git = new GitCommands({
    directory: join(directory, "git"),
    ownerEpoch: spec.cellId,
    artifacts,
    nodeCommand: spec.nodeCommand,
  });
  let fingerprint: ComponentProfile["fingerprint"];
  let cleanupStatus: "stopped" | "unconfirmed" = "unconfirmed";
  try {
    before = now();
    const cold = await captureManifest(root, git, artifacts);
    const coldMs = now() - before;
    before = now();
    const warm = await captureManifest(root, git, artifacts);
    const warmMs = now() - before;
    if (cold.observation.fingerprint !== warm.observation.fingerprint)
      throw new Error("Content changed between profiler fingerprint observations");
    fingerprint = {
      coldMs,
      warmMs,
      files: warm.entries.length,
      bytes: warm.entries.reduce(
        (sum, entry) => sum + ("blob" in entry ? (entry.blob?.size ?? 0) : 0),
        0,
      ),
      status: warm.observation.status,
      cleanup: "unconfirmed",
    };
    await writeFile(join(directory, "fingerprint.json"), canonicalJson({ cold, warm }));
  } finally {
    const cleanup = await git.close();
    cleanupStatus = cleanup.status;
    await writeFile(join(directory, "fingerprint-cleanup.json"), canonicalJson(cleanup));
  }
  if (cleanupStatus !== "stopped") throw new Error("Fingerprint helper cleanup is unconfirmed");
  fingerprint.cleanup = "stopped";
  return {
    readyQueueMs: stat(options.readyQueue),
    outboxScanMs: stat(options.outboxScans),
    consumptionScanMs: stat(consumptionScan),
    consumptionEntries: branch.length,
    sessionValidationMs: stat(validation),
    sessionRestoreMs: stat(restoration),
    sessionEntries,
    skill: {
      freezeMs,
      materializeMs,
      loadMs,
      names: loaded.skills.map((skill) => skill.name),
      files: skills.reduce((count, skill) => count + skill.files.length, 0),
      bytes: skills.reduce(
        (count, skill) => count + skill.files.reduce((sum, file) => sum + file.artifact.size, 0),
        0,
      ),
    },
    fingerprint,
    idle: options.idle,
  };
}
