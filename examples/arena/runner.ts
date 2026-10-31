import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { FakeBackend, fakeResult } from "../../engine/backends/fake.ts";
import { createEngine, basicPipeline } from "../../engine/core/engine.ts";
import { ZERO_USAGE, type TaskSpec } from "../../engine/core/types.ts";
import { Ledger, type ProtocolEvent, type Model, type Meters } from "./protocol.ts";
import { aggregate } from "./summary.mjs";
export { aggregate } from "./summary.mjs";
import { fixtureSource, seededFixtures, type Fixture } from "./fixtures.ts";
import { sandbox, localImage } from "./sandbox.ts";
import { loadTask, freshWorkspace, freeze, verify, hash, type TaskPackage } from "./task.ts";

export const root = fileURLToPath(new URL("./", import.meta.url));
export const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
  schema: number;
  id: string;
  task: string;
  verifierImage: string;
  limits: { generationMs: number; verificationMs: number; costUsd: number; outputBytes: number };
  contestants: Array<{
    id: string;
    name: string;
    version: string;
    integration: string;
    source: string;
  }>;
};
export type Track = "controlled-same-model" | "practical-defaults";
export type LiveConfig = {
  track: Track;
  model?: Model;
  task: string;
  trials: number;
  seed: number;
  limits?: Partial<typeof manifest.limits>;
  contestants: Array<{
    id: string;
    caFile?: string;
    name?: string;
    image: string;
    command: string[];
    version: string;
    source: string;
    network: string;
    settings?: Record<string, any>;
    secrets: string[];
  }>;
};
export type ArenaEvent = {
  v: 1;
  seq: number;
  at: number;
  trial: string | null;
  type: string;
  data: any;
};
export type Trial = {
  id: string;
  contestant: string;
  repetition: number;
  mode: "simulated" | "mock" | "live";
  fixture?: Fixture;
  status: "completed" | "failed" | "cancelled" | "timeout" | "invalid";
  reason: string | null;
  generationMs: number;
  verificationMs: number;
  elapsedMs: number;
  comparable: boolean;
  patch?: { sha256: string; artifact: string };
  quality?: Awaited<ReturnType<typeof verify>>;
  ledger: ReturnType<Ledger["summary"]>;
};
export type RunOptions = {
  out: string;
  mode: "simulated" | "mock" | "live";
  seed?: number;
  trials?: number;
  scenario?: "clean" | "faults";
  fixtures?: Fixture[];
  stepMs?: number;
  track?: Track;
  live?: LiveConfig;
  allowProviderSpend?: boolean;
  signal?: AbortSignal;
  limits?: Partial<typeof manifest.limits>;
  task?: string;
};
class Journal {
  seq = 0;
  readonly file: string;
  constructor(dir: string) {
    this.file = join(dir, "events.jsonl");
  }
  emit(trial: string | null, type: string, data: unknown) {
    const event: ArenaEvent = { v: 1, seq: this.seq++, at: Date.now(), trial, type, data };
    appendFileSync(this.file, JSON.stringify(event) + "\n", { mode: 0o600 });
    return event;
  }
}
function fixedMeter(costUsd: number): Meters {
  return {
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    totalTokens: 190,
    turns: 1,
    toolCalls: 1,
    costUsd,
  };
}
async function fakeContestant(p: {
  dir: string;
  workspace: string;
  fixture: Fixture;
  stepMs: number;
  signal: AbortSignal;
  event: (e: ProtocolEvent) => void;
}) {
  const model = { provider: "fixture", id: "deterministic-v1" };
  const pricing = {
    source: "fixture" as const,
    reference: "Synthetic fixture receipts; not provider prices",
    at: "2026-10-31T00:00:00Z",
  };
  p.event({ type: "session-open", id: "parent", parent: null, role: "parent", model });
  p.event({
    type: "phase",
    session: "parent",
    phase: "planning",
    detail: "Scripted parent delegates a scout, builder and independent review",
  });
  p.event({
    type: "usage",
    id: "parent-planning",
    session: "parent",
    kind: "message",
    model,
    meters: fixedMeter(0.005),
    pricing,
  });
  const backend = new FakeBackend((launch) => ({
    stepMs: p.stepMs,
    usage: {
      ...ZERO_USAGE,
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 190,
      cost: 0.02,
    },
    ...(p.fixture === "failed" &&
      launch.task.id === "build" && { error: "Seeded process failure" }),
    ...(p.fixture === "timeout" && launch.task.id === "build" && { hang: true }),
    result:
      launch.task.id === "review"
        ? fakeResult({ review: { taskId: "build", fingerprint: "fixture", verdict: "approve" } })
        : fakeResult(),
  }));
  const engine = createEngine({
    backends: { fake: backend },
    defaultBackend: "fake",
    pipeline: basicPipeline({ model: { ...model, thinking: "off" }, backend: "fake" }),
  });
  const attempts = new Map<string, number>();
  const sessions = new Map<string, string>();
  engine.onRun((handle) =>
    engine.subscribe(handle.id, (e) => {
      if (e.t === "agent_started" && e.agent) {
        const n = (attempts.get(e.agent) ?? 0) + 1;
        attempts.set(e.agent, n);
        const id = `${e.agent}-${n}`;
        sessions.set(e.agent, id);
        p.event({ type: "session-open", id, parent: "parent", role: e.agent, model });
        p.event({
          type: "phase",
          session: id,
          phase: e.agent === "map" ? "scouting" : e.agent === "review" ? "reviewing" : "building",
          detail: `FakeBackend ${e.agent}, attempt ${n}; fixture activity, not a live product trace`,
        });
      }
      if (e.t === "agent_settled" && e.agent && sessions.has(e.agent)) {
        const id = sessions.get(e.agent)!;
        p.event({
          type: "usage",
          id: `${id}-settlement`,
          session: id,
          kind: attempts.get(e.agent)! > 1 ? "retry" : "message",
          model,
          meters: {
            input: e.usage.input,
            output: e.usage.output,
            cacheRead: e.usage.cacheRead,
            cacheWrite: e.usage.cacheWrite,
            totalTokens: e.usage.totalTokens,
            turns: e.turns,
            toolCalls: e.toolCalls,
            costUsd: p.fixture === "unmetered" ? null : e.usage.cost,
          },
          pricing:
            p.fixture === "unmetered"
              ? { ...pricing, source: "unknown", reference: "Fixture deliberately omits cost" }
              : pricing,
        });
        p.event({ type: "session-close", id, usageComplete: true });
        sessions.delete(e.agent);
      }
    }),
  );
  const tasks: TaskSpec[] = [
    {
      id: "map",
      agent: "scout",
      task: "Inspect the public contract",
      acceptance: ["Public requirements understood"],
    },
    {
      id: "build",
      agent: "builder",
      task: "Implement the public contract",
      acceptance: ["Implementation ready"],
      after: ["map"],
      ownership: ["solution.mjs"],
      noChecksReason: "Scripted fixture; actual grading follows frozen output",
    },
    {
      id: "review",
      agent: "reviewer",
      task: "Review implementation",
      acceptance: ["Independent fixture review"],
      after: ["build"],
      reviewOf: "build",
    },
  ];
  const cancel = () => {
    void engine.shutdown("arena cancelled");
  };
  p.signal.addEventListener("abort", cancel, { once: true });
  try {
    const handle = await engine.run(tasks, {
      dir: join(p.dir, "engine"),
      cwd: p.workspace,
      allowWrites: true,
      mode: "observe",
      limits: { taskMs: 60000, jobMs: 120000 },
    });
    if (p.signal.aborted) cancel();
    let view = await handle.done;
    if (p.fixture === "cancelled" && !p.signal.aborted)
      return { status: "cancelled" as const, reason: "Seeded cancellation" };
    if (view.status === "succeeded" && !p.signal.aborted) {
      // Exercise repaired-attempt accounting for every demo lane using identical topology.
      engine.repair(handle.id, "build", "Fixture repair: independently recheck the same contract");
      view = await handle.done;
    }
    if (view.status !== "succeeded" || p.signal.aborted)
      return {
        status: p.signal.aborted ? ("cancelled" as const) : ("failed" as const),
        reason: "Seeded failure or interrupted generation",
      };
    p.event({
      type: "phase",
      session: "parent",
      phase: "checking",
      detail: "Fixture review complete; external grading still pending",
    });
    await writeFile(join(p.workspace, "solution.mjs"), fixtureSource(p.fixture));
    p.event({
      type: "phase",
      session: "parent",
      phase: "integrating",
      detail: "Scripted parent hands final candidate to the independent verifier",
    });
    p.event({
      type: "usage",
      id: "parent-integration",
      session: "parent",
      kind: "overhead",
      model,
      meters: fixedMeter(0.005),
      pricing,
    });
    p.event({ type: "session-close", id: "parent", usageComplete: true });
    return { status: "completed" as const, reason: "Scripted fixture completed" };
  } finally {
    p.signal.removeEventListener("abort", cancel);
    await engine.shutdown("arena done");
  }
}
function limitsFor(overrides: RunOptions["limits"]) {
  const limits = { ...manifest.limits, ...overrides };
  for (const [key, value] of Object.entries(limits))
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > (key === "costUsd" ? 10000 : key === "outputBytes" ? 16777216 : 3600000)
    )
      throw new Error(`Invalid limit ${key}`);
  return limits;
}
export function validateLiveConfig(value: any): LiveConfig {
  if (
    !value ||
    !["controlled-same-model", "practical-defaults"].includes(value.track) ||
    typeof value.task !== "string" ||
    !Number.isInteger(value.trials) ||
    value.trials < 1 ||
    value.trials > 100 ||
    !Number.isInteger(value.seed) ||
    !Array.isArray(value.contestants) ||
    value.contestants.length < 1 ||
    value.contestants.length > 12
  )
    throw new Error("Invalid live configuration");
  if (
    value.track === "controlled-same-model" &&
    (!value.model ||
      typeof value.model.provider !== "string" ||
      !value.model.provider ||
      typeof value.model.id !== "string" ||
      !value.model.id)
  )
    throw new Error("Controlled track requires an explicit provider and model id");
  const ids = new Set();
  for (const c of value.contestants) {
    if (
      !c ||
      !/^[a-z][a-z0-9-]{0,30}$/.test(c.id) ||
      ids.has(c.id) ||
      !/^(?:[a-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(c.image) ||
      !Array.isArray(c.command) ||
      !c.command.length ||
      c.command.some((v: unknown) => typeof v !== "string" || v.length > 10000) ||
      (!["none", "bridge"].includes(c.network) &&
        !/^pinata-arena-mock-[a-f0-9-]+$/.test(c.network)) ||
      !Array.isArray(c.secrets) ||
      !c.secrets.every((s: unknown) => typeof s === "string" && /^[A-Z][A-Z0-9_]*$/.test(s)) ||
      (c.caFile !== undefined && typeof c.caFile !== "string") ||
      (c.settings !== undefined &&
        (!c.settings || typeof c.settings !== "object" || Array.isArray(c.settings))) ||
      typeof c.version !== "string" ||
      !c.version ||
      typeof c.source !== "string" ||
      !c.source
    )
      throw new Error("Invalid or unpinned live contestant");
    ids.add(c.id);
  }
  return value;
}
export async function runArena(options: RunOptions) {
  if (options.mode === "live" && (!options.allowProviderSpend || !options.live))
    throw new Error(
      "Live execution requires a configured adapter and explicit --allow-provider-spend",
    );
  const live = options.live && validateLiveConfig(options.live);
  if (options.mode !== "simulated" && !live)
    throw new Error("Container runs require a configured adapter");
  const limits = limitsFor(options.limits ?? live?.limits);
  if (
    options.stepMs !== undefined &&
    (!Number.isInteger(options.stepMs) || options.stepMs < 0 || options.stepMs > 1000)
  )
    throw new Error("Invalid fixture step delay");
  const seed = options.seed ?? live?.seed ?? 7;
  const trials = options.trials ?? live?.trials ?? 1;
  if (
    !Number.isSafeInteger(seed) ||
    !Number.isInteger(trials) ||
    trials < 1 ||
    trials > 100 ||
    !["clean", "faults"].includes(options.scenario ?? "clean")
  )
    throw new Error("Invalid seed, trial count or scenario");
  const track = options.track ?? live?.track ?? "controlled-same-model";
  const task: TaskPackage = await loadTask(options.task ?? live?.task ?? join(root, "task"));
  if (options.mode === "simulated" && task.id !== manifest.task)
    throw new Error("Fixtures are defined only for the shipped rehearsal task");
  const image = await localImage(manifest.verifierImage);
  const contestants = options.mode !== "simulated" ? live!.contestants : manifest.contestants;
  const images = new Map<string, string>();
  if (options.mode !== "simulated")
    for (const c of live!.contestants) images.set(c.id, await localImage(c.image));
  if (
    options.mode === "mock" &&
    (!live ||
      live.contestants.some(
        (c) =>
          !/^pinata-arena-mock-[a-f0-9-]+$/.test(c.network) ||
          c.secrets.length ||
          c.settings?.mock !== true,
      ))
  )
    throw new Error(
      "Mock runs require isolated internal networks, mock settings and no credentials",
    );
  const out = resolve(options.out);
  await mkdir(out, { recursive: false, mode: 0o700 });
  const journal = new Journal(out);
  let sourceCommit = "unknown";
  try {
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* Packaged runs may have no Git checkout. */
  }
  const sourceFilesSha256 = Object.fromEntries(
    await Promise.all(
      [
        "runner.ts",
        "protocol.ts",
        "summary.mjs",
        "task.ts",
        "sandbox.ts",
        "fixtures.ts",
        "manifest.json",
      ].map(async (file) => [file, hash(await readFile(join(root, file)))]),
    ),
  );
  let sourceDirty: boolean | null = null;
  try {
    sourceDirty =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length > 0;
  } catch {
    /* Standalone package. */
  }
  const configured = live
    ? {
        ...live,
        contestants: live.contestants.map((c) => ({
          ...c,
          image: images.get(c.id),
          secrets: c.secrets,
        })),
      }
    : null;
  const header = {
    schema: 1,
    id: manifest.id,
    mode: options.mode,
    track,
    seed,
    trials,
    task: { id: task.id, sha256: task.digest },
    sourceCommit,
    sourceDirty,
    sourceFilesSha256,
    node: process.version,
    verifierImage: image,
    verifierImagePin: manifest.verifierImage,
    limits,
    contestants,
    configured,
    simulatedNotice:
      options.mode === "simulated"
        ? "All lanes use the Piñata FakeBackend with scripted candidates and synthetic receipts. These are harness demonstrations, not competitive measurements."
        : options.mode === "mock"
          ? "Real installed CLIs against a scripted isolated mock provider. This validates adapters, not model quality, provider performance or real pricing."
          : null,
    budgetPolicy:
      "Observed receipts trigger cancellation after the threshold. Missing/unreported usage and in-flight calls can exceed it; this is not a provider billing cap.",
  };
  await writeFile(join(out, "manifest.json"), JSON.stringify(header, null, 2) + "\n");
  journal.emit(null, "run-started", header);
  const results: Trial[] = [];
  const fixtures = options.fixtures ?? seededFixtures(seed, options.scenario ?? "clean");
  for (let repetition = 0; repetition < trials; repetition++) {
    // Rotate order across repetitions. No workspace, session, grading feedback or artifact
    // is fed into another repetition. Lanes run sequentially to avoid resource contention.
    const order = [
      ...contestants.slice(repetition % contestants.length),
      ...contestants.slice(0, repetition % contestants.length),
    ];
    for (const contestant of order) {
      const id = `${contestant.id}-${repetition + 1}`;
      const dir = join(out, id);
      await mkdir(dir, { mode: 0o755 });
      const workspace = join(dir, "workspace");
      await freshWorkspace(task, workspace);
      const inputDir = join(dir, "input");
      await mkdir(inputDir, { mode: 0o755 });
      await chmod(inputDir, 0o755);
      const prompt = await readFile(join(workspace, task.prompt), "utf8");
      const input = {
        schema: 1,
        attempt: id,
        task: task.id,
        prompt,
        workspace: "/work",
        entry: task.entry,
        track,
        model: live?.model ?? { provider: "fixture", id: "deterministic-v1" },
        limits,
        adapter: live?.contestants.find((c) => c.id === contestant.id)?.settings ?? {},
        requiredUsage:
          "Report parent, child, retry, compaction and overhead receipts; missing values must be null",
      };
      await writeFile(join(inputDir, "input.json"), JSON.stringify(input), { mode: 0o444 });
      await chmod(join(inputDir, "input.json"), 0o444);
      const ledger = new Ledger();
      const controller = new AbortController();
      const cancel = () => controller.abort("cancelled");
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const fixture =
        options.mode === "simulated"
          ? fixtures[
              manifest.contestants.findIndex((c) => c.id === contestant.id) % fixtures.length
            ]
          : undefined;
      const started = performance.now();
      let budgetHit = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort("timeout");
      }, limits.generationMs);
      journal.emit(id, "trial-started", {
        contestant: contestant.id,
        repetition: repetition + 1,
        mode: options.mode,
        fixture: fixture ?? null,
      });
      const receive = (value: ProtocolEvent) => {
        if (options.mode === "live" && value.type === "usage" && value.pricing.source === "fixture")
          throw new Error("Synthetic receipts cannot be used as live billing");
        const e = ledger.apply(value);
        journal.emit(id, "protocol", e);
        if (ledger.summary().partial.costUsd > limits.costUsd) {
          budgetHit = true;
          controller.abort("observed cost limit");
        }
      };
      let status: Trial["status"] = "failed";
      let reason: string | null = null;
      try {
        if (controller.signal.aborted) {
          status = "cancelled";
          reason = "cancelled before launch";
        } else if (options.mode === "simulated") {
          const ended = await fakeContestant({
            dir,
            workspace,
            fixture: fixture!,
            stepMs: options.stepMs ?? 20,
            signal: controller.signal,
            event: receive,
          });
          receive({ type: "terminal", ...ended });
          status = ended.status;
          reason = ended.status === "completed" ? null : ended.reason;
        } else {
          const c = live!.contestants.find((c) => c.id === contestant.id)!;
          const process = await sandbox({
            image: images.get(c.id)!,
            command: c.command,
            workspace,
            inputDir,
            writable: true,
            caFile: c.caFile,
            memoryMb: typeof c.settings?.memoryMb === "number" ? c.settings.memoryMb : 256,
            timeoutMs: limits.generationMs,
            outputBytes: limits.outputBytes,
            signal: controller.signal,
            network: c.network,
            secrets: c.secrets,
            onLine: (line) => receive(JSON.parse(line)),
          });
          await writeFile(join(dir, "adapter.stderr.txt"), process.stderr, { mode: 0o600 });
          if (process.reason || process.code !== 0 || !ledger.terminal) {
            status = "failed";
            reason =
              process.reason ??
              (process.code !== 0
                ? `adapter exit ${process.code}`
                : "adapter ended without terminal event");
          } else {
            status = ledger.terminal.status;
            reason = ledger.terminal.reason || null;
          }
        }
      } catch (error) {
        status = "invalid";
        reason = (error as Error).message;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
      }
      if (timedOut) {
        status = "timeout";
        reason = "generation deadline exceeded";
      } else if (budgetHit) {
        status = "cancelled";
        reason = "observed cost limit exceeded";
      } else if (options.signal?.aborted) {
        status = "cancelled";
        reason = "cancelled";
      }
      const generationMs = performance.now() - started;
      let patch: Trial["patch"];
      let quality: Trial["quality"];
      const verifyStart = performance.now();
      if (status === "completed") {
        try {
          const frozen = await freeze(task, workspace, join(dir, "candidate"));
          await writeFile(join(dir, "final.patch"), frozen.patch, { mode: 0o444 });
          patch = { sha256: frozen.sha256, artifact: `${id}/final.patch` };
          journal.emit(id, "patch-frozen", patch);
          quality = await verify(
            task,
            join(dir, "candidate"),
            join(dir, "verifier"),
            image,
            seed + repetition,
            limits.verificationMs,
            limits.outputBytes,
          );
          const after = hash(await readFile(join(dir, "candidate", task.entry)));
          if (after !== frozen.sha256)
            throw new Error("Frozen candidate changed during verification");
          journal.emit(id, "verified", quality);
        } catch (error) {
          status = "invalid";
          reason = (error as Error).message;
          journal.emit(id, "verification-error", { reason });
        }
      }
      const verificationMs = performance.now() - verifyStart;
      const accounting = ledger.summary();
      const expectedModel = live?.model ?? { provider: "fixture", id: "deterministic-v1" };
      const comparable =
        track === "practical-defaults" ||
        (accounting.sessions.length > 0 &&
          accounting.sessions.every(
            (s) => s.model.provider === expectedModel.provider && s.model.id === expectedModel.id,
          ) &&
          accounting.receipts.every(
            (r) => r.model.provider === expectedModel.provider && r.model.id === expectedModel.id,
          ));
      const result: Trial = {
        id,
        contestant: contestant.id,
        repetition: repetition + 1,
        mode: options.mode,
        ...(fixture && { fixture }),
        status,
        reason,
        generationMs,
        verificationMs,
        elapsedMs: performance.now() - started,
        comparable,
        ...(patch && { patch }),
        ...(quality && { quality }),
        ledger: accounting,
      };
      results.push(result);
      journal.emit(id, "trial-settled", result);
      await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
      // Persist partial results after every terminal attempt, including failures.
      await writeFile(
        join(out, "results.json"),
        JSON.stringify(
          { manifest: header, trials: results, aggregates: aggregate(results) },
          null,
          2,
        ) + "\n",
      );
    }
  }
  const summary = { manifest: header, trials: results, aggregates: aggregate(results) };
  journal.emit(null, "run-settled", summary.aggregates);
  await writeFile(join(out, "results.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}
export async function replayArena(dir: string) {
  const raw = await readFile(join(dir, "events.jsonl"), "utf8");
  const lines = raw.split("\n");
  const events: ArenaEvent[] = [];
  for (const [i, line] of lines.entries()) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (
        e.v !== 1 ||
        e.seq !== events.length ||
        typeof e.at !== "number" ||
        typeof e.type !== "string"
      )
        throw new Error("Invalid event envelope or sequence");
      events.push(e);
    } catch (error) {
      if (i === lines.length - 1 && !raw.endsWith("\n")) break;
      throw error;
    }
  }
  if (events[0]?.type !== "run-started") throw new Error("Missing run-started");
  const ledgers = new Map<string, Ledger>();
  const trials: Trial[] = [];
  for (const e of events) {
    if (e.type === "trial-started") {
      if (!e.trial || ledgers.has(e.trial)) throw new Error("Duplicate trial");
      ledgers.set(e.trial, new Ledger());
    }
    if (e.type === "protocol") {
      const ledger = ledgers.get(e.trial!);
      if (!ledger) throw new Error("Missing trial");
      ledger.apply(e.data);
    }
    if (e.type === "trial-settled") {
      const ledger = ledgers.get(e.trial!);
      if (
        !ledger ||
        JSON.stringify(ledger.summary()) !== JSON.stringify(e.data.ledger) ||
        trials.some((r) => r.id === e.trial)
      )
        throw new Error("Settlement ledger mismatch");
      trials.push(e.data);
    }
  }
  return {
    manifest: events[0].data,
    trials,
    aggregates: aggregate(trials),
    events,
    complete: events.at(-1)?.type === "run-settled",
  };
}
