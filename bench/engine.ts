import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { promisify } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  assignmentKey,
  configSchema,
  type CallerAuthority,
  type CoreState,
  type BackendPort,
  type ArtifactPort,
} from "../engine/contracts/index.ts";
import { Runtime } from "../engine/runtime/index.ts";
import { InProcessBackend } from "../engine/backends/in-process.ts";
import { ProcessBackend } from "../engine/backends/process.ts";
import { HerdrBackend } from "../engine/backends/herdr.ts";
import { WorkspaceLayer } from "../engine/workspace/index.ts";
import { createWorkerResolver } from "../engine/definitions/index.ts";
import { verifyArtifact, inspectStore } from "../engine/storage/journal.ts";
import { initialState, reduce } from "../engine/core/state.ts";
import { validateAssignmentGraph } from "../engine/core/graph.ts";
import { readyAssignments } from "../engine/core/readiness.ts";
import { bindRuntime, type RuntimeSource } from "../engine/sources/runtime.ts";
import { ScreenRouter } from "../engine/ui/router.ts";
import { renderScreen } from "../engine/ui/render.ts";
import { createPaint } from "../engine/ui/palette.ts";
import { Observer } from "./observer.ts";
import {
  installProvider,
  modelId,
  providerId,
  readProviderRecords,
  startLoopback,
  type ProviderSettings,
} from "./providers.ts";
import { collectGarbage, mb, now, osIo, retainedBytes, stat } from "./metrics.ts";
import { taskText, warmupScenario, idleScenario } from "./workloads.ts";
import { profileComponents, resourcePlateau, sampleIdle } from "./profile.ts";
import { type BenchResult, type CellSpec, type Scenario, type IdleSample } from "./types.ts";

const executeFile = promisify(execFile);
const tools = {
  read: { access: "read" },
  grep: { access: "read" },
  ls: { access: "read" },
  write: { access: "write" },
} as const;
type Fixture = { repository: string; agentDir: string; definitions: string };
export async function prepareFixture(directory: string): Promise<Fixture> {
  const repository = join(directory, "repo");
  const agentDir = join(directory, "agent");
  const definitions = join(directory, "definitions");
  await Promise.all([
    mkdir(join(repository, "src"), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(definitions, { recursive: true }),
  ]);
  await writeFile(
    join(repository, "README.md"),
    "# Benchmark fixture\n\nA synthetic repository.\n",
  );
  await Promise.all(
    Array.from({ length: 200 }, (_, index) =>
      writeFile(
        join(repository, "src", `module-${index}.ts`),
        `export function value${index}(input: number) {\n  return input * ${index};\n}\n`,
      ),
    ),
  );
  for (const role of ["scout", "planner", "builder", "reviewer"]) {
    const header = {
      schemaVersion: 1,
      name: role,
      handoffDescription: "Scripted benchmark fixture",
      tools: role === "builder" ? ["read", "grep", "ls", "write"] : ["read", "grep", "ls"],
      pinata: { access: role === "builder" ? "write" : "read", checkpoint: "none" },
    };
    await writeFile(
      join(definitions, `${role}.md`),
      `---\n${JSON.stringify(header)}\n---\nRun the supplied deterministic benchmark workload.\n`,
    );
  }
  await executeFile("git", ["init", "-q", repository]);
  await executeFile("git", ["-C", repository, "add", "-A"]);
  await executeFile("git", [
    "-C",
    repository,
    "-c",
    "user.name=Pinata benchmark",
    "-c",
    "user.email=benchmark@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Scripted fixture baseline",
  ]);
  return {
    repository: await realpath(repository),
    agentDir: await realpath(agentDir),
    definitions: await realpath(definitions),
  };
}
async function runWorkload(
  spec: CellSpec,
  scenario: Scenario,
  fixture: Fixture,
  modelRuntime: ModelRuntime,
  observer: Observer,
  onRuntime?: (source: RuntimeSource) => Promise<void>,
  onSettled?: (cycle: number, router?: ScreenRouter) => Promise<void>,
) {
  const run = `${spec.cellId}-${scenario.name}`;
  const requested = join(spec.directory, "runs", scenario.name);
  await mkdir(requested, { recursive: true });
  const directory = await realpath(requested);
  const config = configSchema.parse({
    mode: spec.mode,
    workspace: spec.workspace,
    backend: spec.backend,
    codemode: false,
    models: { default: { provider: providerId, id: modelId, thinking: "off" } },
    execution: { maxConcurrent: scenario.capacity },
  });
  const caller: CallerAuthority = {
    id: "benchmark",
    kind: "coordinator",
    run,
    grants: {
      access: "write",
      tools: Object.keys(tools),
      workspaces: ["shared", "worktree"],
      inheritContext: false,
      memory: { scope: "none", access: "read" },
      delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
    },
  };
  const workspace = new WorkspaceLayer({
    root: fixture.repository,
    storeDirectory: directory,
    nodeCommand: spec.nodeCommand,
    fault: observer.fault,
  });
  const processOptions = {
    agentDir: fixture.agentDir,
    nodeCommand: spec.nodeCommand,
    codemode: false,
    bootstrapModule: fileURLToPath(new URL("./providers.ts", import.meta.url)),
  };
  const backend: BackendPort =
    spec.backend === "in-process"
      ? new InProcessBackend({
          agentDir: fixture.agentDir,
          modelRuntime: async () => modelRuntime,
          codemode: false,
        })
      : spec.backend === "process"
        ? new ProcessBackend(processOptions)
        : new HerdrBackend(processOptions);
  if (!backend.capabilities.available)
    throw new Error(`unavailable: ${backend.capabilities.reason ?? spec.backend}`);
  const wrapped = observer.backend(backend);
  let runtime: Runtime;
  let notifications: Promise<unknown> = Promise.resolve();
  runtime = await Runtime.open({
    directory,
    manifest: {
      schemaVersion: 1,
      run,
      workspace: fixture.repository,
      store: directory,
      createdAt: new Date().toISOString(),
    },
    resolveConfig: () => config,
    fault: observer.fault,
    resolveWorkers: createWorkerResolver({
      cwd: fixture.repository,
      agentDir: fixture.agentDir,
      definitionDirectories: [fixture.definitions],
      config: { run: config },
      tools,
      backends: { [spec.backend]: backend.capabilities },
      modelAvailable: (model) => Boolean(modelRuntime.getModel(model.provider, model.id)),
      async freezeWorker(worker, _request, authority, artifacts) {
        const port: ArtifactPort = observer.artifacts({
          ...artifacts,
          read: (ref) => verifyArtifact(directory, ref),
        });
        return {
          ...worker,
          workspacePlan: await workspace.freeze(
            { run: authority.run, worker: worker.id, mode: worker.workspace },
            port,
          ),
        };
      },
    }),
    execution: { backends: { [spec.backend]: wrapped }, workspace: observer.workspace(workspace) },
    notifications: {
      deduplicates: true,
      async deliver(notice) {
        observer.notices[assignmentKey(notice.ref)] = now();
        return { status: "delivered" };
      },
    },
    onDiagnostic: (diagnostic) => observer.errors.push(diagnostic.message),
  });
  const source = bindRuntime(runtime, caller);
  const unsubscribe = runtime.subscribe({}, caller, (event) => {
    observer.event(event);
    if (event.kind === "committed" && event.transition.kind === "settled")
      notifications = notifications.then(() => runtime.deliverNotifications(caller));
  });
  const profile = { projectionMs: 0, renderMs: 0, renderRequests: 0, navigation: [] as number[] };
  let router: ScreenRouter | undefined;
  if (spec.viewer) {
    const measured: RuntimeSource = {
      ...source,
      async subscribe(consume) {
        return source.subscribe((event) => {
          const before = now();
          const renderBefore = profile.renderMs;
          const result = consume(event);
          profile.projectionMs += now() - before - (profile.renderMs - renderBefore);
          return result;
        });
      },
    };
    router = new ScreenRouter(measured, { ui: config.ui });
    const screen = router;
    screen.onChange(() => {
      const before = now();
      renderScreen(screen, { width: 120, height: 40, paint: createPaint("terminal-default") });
      profile.renderMs += now() - before;
      profile.renderRequests++;
    });
    await screen.start();
    screen.navigate("fleet");
  }
  await onRuntime?.(source);
  let state: CoreState = initialState(run);
  let closeStatus = "not_closed";
  let fullLogDeliveryMs = 0;
  const outboxScans: number[] = [];
  try {
    for (let assignment = 1; assignment <= scenario.histories; assignment++) {
      if (assignment === 1) {
        const before = now();
        for (const task of scenario.tasks)
          observer.called[assignmentKey({ run, worker: task.id, assignment })] = before;
        const receipt = await runtime.execute(
          {
            requestId: "create",
            command: {
              kind: "create",
              config,
              workers: scenario.tasks.map((task) => ({
                id: task.id,
                agent: task.role,
                task: taskText(task, assignment),
                after: task.after,
                workspace: spec.workspace,
                backend: spec.backend,
                lifetime: spec.lifetime,
              })),
            },
          },
          caller,
        );
        observer.acceptance.push(now() - before);
        if (receipt.status !== "accepted") throw new Error(JSON.stringify(receipt.error));
      } else {
        for (const task of scenario.tasks) {
          const before = now();
          observer.called[assignmentKey({ run, worker: task.id, assignment })] = before;
          const receipt = await runtime.execute(
            {
              requestId: `follow-${task.id}-${assignment}`,
              command: {
                kind: "follow_up",
                worker: task.id,
                messageId: `input-${task.id}-${assignment}`,
                text: taskText(task, assignment),
              },
            },
            caller,
          );
          observer.acceptance.push(now() - before);
          if (receipt.status !== "accepted") throw new Error(JSON.stringify(receipt.error));
        }
      }
      const waiting = await runtime.wait({}, caller);
      if (
        waiting.status !== "settled" ||
        waiting.results.some(
          (result) => result.execution.phase !== "ended" || result.execution.reason !== "completed",
        )
      )
        throw new Error(
          `Workload did not complete: ${JSON.stringify(waiting.results.map((entry) => ({ ref: entry.ref, execution: entry.execution, summary: entry.summary, errors: entry.finalizationErrors })))}`,
        );
      if (onSettled) {
        await notifications;
        await runtime.deliverNotifications(caller);
        await onSettled(assignment, router);
      }
    }
    await notifications;
    await runtime.deliverNotifications(caller);
    const result = await runtime.query({ kind: "status" }, caller);
    if (result.kind !== "status") throw new Error("Status projection is unavailable");
    state = result.state;
    for (let pass = 0; pass < 5; pass++) {
      const before = now();
      const remaining = await runtime.deliverNotifications(caller);
      outboxScans.push(now() - before);
      if (remaining.length)
        throw new Error("Completed outbox scan unexpectedly dispatched more work");
    }
    const before = now();
    runtime.subscribe({ since: 0 }, caller, () => {})();
    fullLogDeliveryMs = now() - before;
    if (router)
      for (let cycle = 0; cycle < 100; cycle++) {
        const begin = now();
        router.navigate(cycle % 2 ? "fleet" : "main");
        profile.navigation.push(now() - begin);
      }
  } finally {
    unsubscribe();
    router?.dispose();
    await notifications.catch((error: unknown) =>
      observer.errors.push(error instanceof Error ? error.message : String(error)),
    );
    closeStatus = (await runtime.close()).status;
  }
  return { directory, state, closeStatus, fullLogDeliveryMs, profile, outboxScans };
}
export async function runCell(
  spec: CellSpec,
  options: { onRuntime?(source: RuntimeSource): Promise<void> } = {},
): Promise<BenchResult> {
  const fixture = await prepareFixture(spec.directory);
  const records = join(spec.directory, "provider.jsonl");
  await writeFile(records, "");
  const local =
    spec.provider === "loopback"
      ? await startLoopback({
          scenario: spec.scenario,
          tokenDelayMs: spec.tokenDelayMs,
          records,
          token: spec.cellId,
        })
      : undefined;
  try {
    const settings: ProviderSettings = {
      scenario: spec.scenario,
      tokenDelayMs: spec.tokenDelayMs,
      provider: spec.provider,
      records,
      token: spec.cellId,
      ...(local ? { origin: local.origin } : {}),
    };
    await writeFile(join(fixture.agentDir, "bench-provider.json"), JSON.stringify(settings));
    const modelRuntime = await ModelRuntime.create({
      authPath: join(fixture.agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    installProvider(modelRuntime, settings);
    await modelRuntime.refresh({ allowNetwork: false });
    const warmStart = now();
    const warm = await runWorkload(
      { ...spec, viewer: false },
      warmupScenario,
      fixture,
      modelRuntime,
      new Observer(),
    );
    const warmup = { completed: warm.closeStatus === "closed", milliseconds: now() - warmStart };
    if (!warmup.completed) throw new Error("Warm-up cleanup is unconfirmed");
    await writeFile(
      join(spec.directory, "warmup.json"),
      JSON.stringify({ warmup, directory: warm.directory, results: warm.state.results }),
    );
    const settledHeapMeasured = collectGarbage();
    const baseline = process.memoryUsage();
    let peakRss = baseline.rss;
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 10);
    sample.unref();
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const ioBefore = await osIo();
    const cpuBefore = process.cpuUsage();
    const start = now();
    const observer = new Observer();
    let measured: Awaited<ReturnType<typeof runWorkload>>;
    try {
      measured = await runWorkload(
        spec,
        spec.scenario,
        fixture,
        modelRuntime,
        observer,
        options.onRuntime,
      );
    } finally {
      clearInterval(sample);
      lag.disable();
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const wallMs = now() - start;
    const cpu = process.cpuUsage(cpuBefore);
    const ioAfter = await osIo();
    collectGarbage();
    const settledHeapDeltaMB = settledHeapMeasured
      ? mb(Math.max(0, process.memoryUsage().heapUsed - baseline.heapUsed))
      : null;
    const provider = (await readProviderRecords(records)).filter(
      (entry) => entry.purpose === "workload" && !entry.key.startsWith("warm-up/"),
    );
    const first = new Map<string, number>();
    const peaks: Record<string, number> = {};
    const loaded: Record<string, number> = {};
    for (const record of provider) {
      const [worker, assignment] = record.key.split("/");
      const key = assignmentKey({
        run: measured.state.run,
        worker,
        assignment: Number(assignment),
      });
      if (!first.has(key)) first.set(key, record.at);
      peaks[key] = Math.max(peaks[key] ?? 0, mb(record.rss));
      loaded[key] = (loaded[key] ?? 0) + 1;
    }
    const samples: BenchResult["samples"] = {
      ...observer.stages,
      hostMemoryMB: { baseline: mb(baseline.rss), peak: mb(peakRss) },
      launchedAt: observer.launched,
      setupAt: observer.setup,
      settledAt: observer.settled,
      calledAt: observer.called,
      acceptedAt: observer.accepted,
      providerAt: Object.fromEntries(first),
      spawnMs: {},
      setupMs: {},
      toolCallMs: {},
      dependentMs: {},
      dependentRequestMs: {},
      acceptanceMs: {},
      notificationLagMs: {},
      cleanupMs: observer.cleanup,
      restoreMs: observer.restore,
    };
    for (const [index, value] of observer.acceptance.entries())
      samples.acceptanceMs[String(index)] = value;
    for (const assignment of Object.values(measured.state.assignments)) {
      const key = assignmentKey(assignment.ref);
      const request = first.get(key);
      const launch = observer.launched[key];
      const setup = observer.setup[key];
      if (request !== undefined && launch !== undefined) samples.spawnMs[key] = request - launch;
      if (request !== undefined && setup !== undefined) samples.setupMs[key] = request - setup;
      const dependencies = observer.after.get(key) ?? [];
      if (!dependencies.length && request !== undefined)
        samples.toolCallMs[key] = request - observer.called[key];
      if (
        dependencies.length &&
        dependencies.every((dependency) => observer.settled[dependency] !== undefined)
      ) {
        const ready = Math.max(...dependencies.map((dependency) => observer.settled[dependency]));
        if (launch !== undefined) samples.dependentMs[key] = launch - ready;
        if (request !== undefined) samples.dependentRequestMs[key] = request - ready;
      }
      if (observer.notices[key] !== undefined && observer.settled[key] !== undefined)
        samples.notificationLagMs[key] = observer.notices[key] - observer.settled[key];
    }
    const inspection = await inspectStore(measured.directory);
    let replay = initialState(measured.state.run);
    let reducerMs = 0;
    let acceptanceReducerMs = 0;
    let consumptionReducerMs = 0;
    const readyQueue: number[] = [];
    for (const frame of inspection.frames) {
      const before = now();
      replay = reduce(replay, frame.record.transition, frame.record.revision);
      const duration = now() - before;
      reducerMs += duration;
      if (frame.record.transition.kind === "accepted") acceptanceReducerMs += duration;
      if (frame.record.transition.kind === "inbox_state") consumptionReducerMs += duration;
      if (frame.record.transition.kind === "accepted") {
        const before = now();
        readyAssignments(replay);
        readyQueue.push(now() - before);
      }
    }
    const graphStart = now();
    validateAssignmentGraph(replay, []);
    const graphValidationMs = now() - graphStart;
    const statuses: Record<string, number> = {};
    const results = Object.values(measured.state.results).map((entry) => entry.result);
    for (const result of results) {
      const status =
        result.execution.phase === "ended" ? result.execution.reason : result.execution.phase;
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
    const usage = {
      expectedAttempts: Object.keys(measured.state.attempts).length,
      measuredAttempts: new Set(
        results.flatMap((result) =>
          result.usage.observations.map((observation) => observation.attempt),
        ),
      ).size,
      complete: results.every((result) => result.usage.complete),
    };
    const idleSamples: IdleSample[] = [];
    const idleWorkload = idleScenario(
      spec.backend === "in-process" ? Math.min(8, spec.scenario.tasks.length) : 1,
    );
    const idle = await runWorkload(
      { ...spec, workspace: "shared", viewer: true },
      idleWorkload,
      fixture,
      modelRuntime,
      new Observer(),
      undefined,
      async (cycle, router) => {
        for (let navigation = 0; navigation < 20; navigation++)
          router?.navigate(navigation % 2 ? "fleet" : "main");
        await local?.drainIdle();
        idleSamples.push(await sampleIdle(cycle));
      },
    );
    const idleResults = Object.values(idle.state.results);
    if (!idleResults.every(({ result }) => result.usage.complete))
      throw new Error("Idle resource profile lacks complete scripted usage");
    const components = await profileComponents({
      spec,
      directory: measured.directory,
      state: measured.state,
      repository: fixture.repository,
      agentDir: fixture.agentDir,
      readyQueue,
      outboxScans: measured.outboxScans,
      idle: {
        samples: idleSamples,
        resourcePlateau: resourcePlateau(idleSamples),
        cleanup: idle.closeStatus,
        assignments: idleResults.length,
      },
    });
    await writeFile(join(spec.directory, "component-profile.json"), JSON.stringify(components));
    const packageFile = join(
      dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
      "..",
      "package.json",
    );
    const sdk: unknown = JSON.parse(await readFile(packageFile, "utf8"));
    const pi = sdk && typeof sdk === "object" && "version" in sdk ? String(sdk.version) : "unknown";
    return {
      schemaVersion: 1,
      cellId: spec.cellId,
      scenario: spec.scenario.name,
      backend: spec.backend,
      provider: spec.provider,
      host: spec.host,
      runtime: {
        node: process.version,
        ...(process.versions.bun ? { bun: process.versions.bun } : {}),
        pi,
        platform: process.platform,
        architecture: process.arch,
      },
      status: observer.errors.length || local?.errors.length ? "failed" : "completed",
      agents: spec.scenario.tasks.length,
      assignments: spec.scenario.tasks.length * spec.scenario.histories,
      statuses,
      usage,
      warmup,
      spawnMs: stat(Object.values(samples.spawnMs)),
      setupMs: stat(Object.values(samples.setupMs)),
      toolCallMs: stat(Object.values(samples.toolCallMs)),
      dependentMs: stat(Object.values(samples.dependentMs)),
      dependentRequestMs: stat(Object.values(samples.dependentRequestMs)),
      acceptanceMs: stat(observer.acceptance),
      journalSyncMs: stat(observer.journalSync),
      artifactSyncMs: stat(observer.artifactSync),
      queueMs: observer.queue(spec.scenario.capacity),
      restoreMs: stat(Object.values(observer.restore)),
      cleanupMs: stat(Object.values(observer.cleanup)),
      notificationLagMs: stat(Object.values(samples.notificationLagMs)),
      loopLagP95Ms: lag.count ? lag.percentile(95) / 1e6 : null,
      loopLagP99Ms: lag.count ? lag.percentile(99) / 1e6 : null,
      memoryPerAgentMB:
        spec.backend === "in-process"
          ? mb(Math.max(0, peakRss - baseline.rss)) / Math.max(1, observer.maxRunning)
          : Object.values(peaks).length
            ? Object.values(peaks).reduce((sum, value) => sum + value, 0) /
              Object.values(peaks).length
            : null,
      peakRssMB: mb(peakRss),
      settledHeapDeltaMB,
      settledHeapMeasured,
      cpuMs: (cpu.user + cpu.system) / 1000,
      wallMs,
      samples,
      process:
        spec.backend === "in-process"
          ? null
          : {
              startupDefinition:
                "Backend invocation to first ordinary workload provider request; includes guardian enrollment and any preceding compaction.",
              startupMs: stat(Object.values(samples.setupMs)),
              childPeakRssMB: stat(Object.values(peaks)),
              peakRssByAssignmentMB: peaks,
              loadedSamplesByAssignment: loaded,
              rssMethod: `provider-workload-request-loaded-rss-v1:${process.platform}`,
            },
      io: {
        artifactBytesRead: observer.artifactBytesRead,
        artifactBytesSubmitted: observer.artifactBytesSubmitted,
        journalBytes: (await readFile(join(measured.directory, "journal.jsonl"))).length,
        retainedBytes: await retainedBytes(measured.directory),
        osReadBytes: ioBefore && ioAfter ? ioAfter.read - ioBefore.read : null,
        osWriteBytes: ioBefore && ioAfter ? ioAfter.written - ioBefore.written : null,
        coverage:
          "Artifact port logical transfers and final retained bytes on all platforms; Linux rchar/wchar also includes host file/pipe traffic. Artifact sync percentiles include only nonoverlapping observed operations.",
      },
      profile: {
        reducerMs,
        acceptanceReducerMs,
        consumptionReducerMs,
        graphValidationMs,
        fullLogDeliveryMs: measured.fullLogDeliveryMs,
        projectionMs: measured.profile.projectionMs,
        renderMs: measured.profile.renderMs,
        renderRequests: measured.profile.renderRequests,
        navigationMs: stat(measured.profile.navigation),
        journalFrames: inspection.frames.length,
        fsync: observer.fsync(),
        components,
      },
      observations: {
        requestedMode: spec.mode,
        viewer: spec.viewer,
        activityEvents: observer.activityEvents,
        committedEvents: observer.committedEvents,
        painted: false,
      },
      cleanup: { runtime: measured.closeStatus, leasesReleased: observer.leases.size === 0 },
      errors: [...observer.errors, ...(local?.errors ?? [])],
    };
  } finally {
    await local?.close();
  }
}
