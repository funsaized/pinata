import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CleanupReceipt } from "../engine/contracts/backend.ts";
import { openSavedSource } from "../engine/sources/saved.ts";
import {
  conditionSchema,
  limitsSchema,
  type Artifact,
  type Condition,
  type Limits,
  type RecordedObservation,
} from "./contracts.ts";
import { type FrozenTask } from "./corpus.ts";
import { candidatePath, captureTree, EvidenceStore, materializeSnapshot } from "./evidence.ts";
import { Observer } from "./observer.ts";
import { runProcess } from "./process.ts";

export const adapterSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("offline"),
    mode: z.enum(["known-good", "noop", "broken", "repair-control"]),
  }),
  z.strictObject({
    kind: z.literal("external"),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }),
  z.strictObject({
    kind: z.literal("native"),
    system: z.enum(["pinata", "pi", "codex"]),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }),
]);
export type Adapter = z.infer<typeof adapterSchema>;
export const adapterConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  adapter: adapterSchema,
  condition: conditionSchema,
  limits: limitsSchema.optional(),
});
export const adapterResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  completed: z.boolean(),
  observed: conditionSchema.nullable(),
  observations: z.array(z.unknown()),
  limitations: z.array(z.string()),
});
export type AdapterContext = {
  adapter: Adapter;
  task: FrozenTask;
  candidate: string;
  directory: string;
  store: EvidenceStore;
  requested: Condition;
  limits: Limits;
  cell: string;
  attempt: string;
  origin: number;
  signal?: AbortSignal;
};
export type AdapterResult = {
  state: "completed" | "failed" | "timed_out" | "cancelled";
  observed: Condition | null;
  records: RecordedObservation[];
  evidence: Artifact[];
  cleanup: CleanupReceipt;
  reasons: string[];
  snapshots: Artifact[];
};
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

async function writeControlFiles(
  context: AdapterContext,
  directory: string,
  files: readonly string[],
  solution: boolean,
): Promise<void> {
  const snapshot = solution ? context.task.solution : context.task.starter;
  for (const path of files) {
    const file = snapshot.files.find((entry) => entry.path === path);
    if (!file) throw new Error(`Control file missing: ${path}`);
    const target = candidatePath(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await context.store.read(file.artifact), { mode: file.mode });
  }
}
async function offline(
  context: AdapterContext,
  mode: Extract<Adapter, { kind: "offline" }>["mode"],
): Promise<AdapterResult> {
  const observer = new Observer();
  const snapshots: Artifact[] = [];
  const requested = context.requested;
  if (requested.workflow === "native")
    throw new Error("Offline controls require a prescribed workflow");
  const coordinator = `${context.attempt}/coordinator`;
  observer.record(
    {
      kind: "start",
      run: context.cell,
      worker: "coordinator",
      assignment: 1,
      attempt: coordinator,
    },
    "supervisor",
  );
  const stage = async (id: string, action: () => Promise<void>): Promise<void> => {
    context.signal?.throwIfAborted();
    const attempt = `${context.attempt}/${id}`;
    observer.record(
      {
        kind: "start",
        run: context.cell,
        worker: id,
        assignment: 1,
        attempt,
        parentAttempt: coordinator,
      },
      "supervisor",
    );
    observer.record(
      {
        kind: "stage",
        stage: id.startsWith("review") ? "review" : "build",
        subject: id,
        action: "start",
      },
      "supervisor",
    );
    await action();
    observer.record(
      {
        kind: "usage",
        observation: { attempt, source: "scripted-control", kind: "attempt_total", usage: zero },
      },
      "supervisor",
    );
    observer.record({ kind: "settled", attempt, complete: true }, "supervisor");
    observer.record(
      {
        kind: "stage",
        stage: id.startsWith("review") ? "review" : "build",
        subject: id,
        action: "end",
      },
      "supervisor",
    );
  };
  const copiesSolution = mode !== "noop";
  if (requested.workflow.startsWith("parallel")) {
    const branches = [];
    for (const unit of context.task.task.units) {
      const branch = join(context.directory, `control-${unit.id}`);
      await materializeSnapshot(context.task.starter, context.store, branch);
      branches.push({ branch, unit });
    }
    await Promise.all(
      branches.map(({ branch, unit }) =>
        stage(unit.id, () => writeControlFiles(context, branch, unit.files, copiesSolution)),
      ),
    );
    for (const { unit } of branches)
      await writeControlFiles(context, context.candidate, unit.files, copiesSolution);
  } else {
    for (const unit of context.task.task.units)
      await stage(unit.id, () =>
        writeControlFiles(context, context.candidate, unit.files, copiesSolution),
      );
  }
  if (mode === "broken" || mode === "repair-control") {
    const first = context.task.task.units[0];
    await writeControlFiles(context, context.candidate, first.files, false);
  }
  if (requested.workflow.endsWith("review"))
    await stage("review", async () => {
      if (mode === "repair-control" && context.limits.maxRepairs > 0)
        await writeControlFiles(context, context.candidate, context.task.task.units[0].files, true);
    });
  const snapshot = await captureTree(context.candidate, context.store, {
    boundary: "stage",
    elapsedMs: performance.now() - context.origin,
  });
  snapshots.push(snapshot.ref);
  observer.record(
    {
      kind: "usage",
      observation: {
        attempt: coordinator,
        source: "scripted-control",
        kind: "attempt_total",
        usage: zero,
      },
    },
    "supervisor",
  );
  observer.record({ kind: "settled", attempt: coordinator, complete: true }, "supervisor");
  return {
    state: "completed",
    observed: {
      ...requested,
      system: `scripted-${mode}`,
      backend: "scripted",
      workspace: "shared",
      lifetime: "attached",
      model: null,
    },
    records: observer.records,
    evidence: [],
    cleanup: { status: "stopped", ownerEpoch: context.attempt, identities: [], evidence: [] },
    reasons: ["Reference-copy controls do not measure model coding quality"],
    snapshots,
  };
}

export function nativeInvocation(
  context: Pick<
    AdapterContext,
    "adapter" | "task" | "candidate" | "requested" | "limits" | "directory"
  >,
): { command: string; args: string[]; env: Record<string, string> } {
  const adapter = context.adapter;
  if (
    adapter.kind !== "native" ||
    context.requested.workflow !== "native" ||
    !context.requested.model
  )
    throw new Error("Native adapters require native workflow and an explicit model");
  const model = context.requested.model;
  const workerCount = context.requested.model.settings.concurrency;
  if (workerCount !== undefined && (!Number.isInteger(workerCount) || Number(workerCount) < 1))
    throw new Error("Requested worker count must be positive");
  const prompt = [
    "Complete this project in the candidate checkout. Plan briefly, execute, inspect results and finish the delivered files.",
    context.task.task.prompt,
    ...(workerCount === undefined || adapter.system === "pi"
      ? []
      : [
          `The experimental requested worker count is ${workerCount}. Record any deviation; choose useful independent assignments.`,
        ]),
    `Public unit hints, unchanged from corpus: ${JSON.stringify(context.task.task.units)}`,
    `The external experiment has ${context.limits.timeoutMs} ms. Do not inspect reference solutions or private oracles.`,
    adapter.system === "pi"
      ? "Use Pi's ordinary coding tools for this solo condition."
      : adapter.system === "codex"
        ? "Use native subagents for useful independent work, with the requested model/settings. Coordinate and integrate their output."
        : `Use pinata_run with command:{kind:create,workers:[...]} for useful delegation. Add workers with kind:add, and continue using kind:follow_up. Use backend ${context.requested.backend}, workspace ${context.requested.workspace}, lifetime ${context.requested.lifetime}. Ordinary coding tools remain available. Execution completion does not certify correctness. Deliver isolated changes with explicit pinata_integrate when appropriate.`,
  ].join("\n\n");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.NODE_OPTIONS;
  env.PINATA_ARENA_REQUEST = join(context.directory, "native-request.json");
  if (adapter.system === "codex")
    return {
      command: adapter.command,
      args: [
        ...adapter.args,
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--model",
        model.id,
        "-c",
        `model_provider=${JSON.stringify(model.provider)}`,
        "-c",
        `model_reasoning_effort=${JSON.stringify(model.settings.thinking ?? "high")}`,
        "--",
        prompt,
      ],
      env,
    };
  return {
    command: adapter.command,
    args: [
      ...adapter.args,
      "--print",
      "--offline",
      "--session",
      join(context.directory, "coordinator.jsonl"),
      "--mode",
      "json",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-mcp",
      "--provider",
      model.provider,
      "--model",
      model.id,
      "--thinking",
      String(model.settings.thinking ?? "high"),
      ...(adapter.system === "pinata"
        ? ["-e", fileURLToPath(new URL("./native-extension.ts", import.meta.url))]
        : []),
      "--",
      prompt,
    ],
    env,
  };
}

export async function collectPinataEvidence(directory: string, observer: Observer): Promise<void> {
  const source = await openSavedSource(directory);
  const state = source.snapshot().snapshot;
  for (const entry of Object.values(state.attempts)) {
    const { attempt } = entry;
    observer.record({
      kind: "start",
      run: attempt.ref.run,
      worker: attempt.ref.worker,
      assignment: attempt.ref.assignment,
      attempt: attempt.id,
    });
    for (const [response, status] of Object.entries(entry.responses))
      observer.record({ kind: "response", attempt: attempt.id, response, state: status });
    for (const observation of [
      ...entry.usageObservations,
      ...(entry.outcome?.usage.observations ?? []),
    ])
      observer.record({ kind: "usage", observation });
    observer.record({
      kind: "settled",
      attempt: attempt.id,
      complete: entry.outcome?.usage.complete === true,
    });
  }
}

function nativeStream(
  bytes: Buffer,
  system: string,
  observer: Observer,
  coordinator: string,
): boolean {
  let completed = false;
  let response = 0;
  for (const line of bytes.toString().split("\n").filter(Boolean)) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line);
    } catch {
      observer.record({ malformed: "Native stream is not complete JSONL" });
      continue;
    }
    if (system === "codex") {
      if (value.type === "turn.completed") {
        completed = true;
        // Codex's parent totals do not establish child coverage. Keep the whole
        // native assignment unknown until a full child registry is available.
        const reported = value.usage;
        if (reported && typeof reported === "object") {
          const usage = reported as Record<string, unknown>;
          const input = usage.input_tokens;
          const cached = usage.cached_input_tokens ?? 0;
          if (typeof input === "number" && typeof cached === "number")
            observer.record({
              kind: "usage",
              observation: {
                attempt: coordinator,
                source: "codex-parent",
                kind: "attempt_total",
                usage: {
                  input: input - cached,
                  cacheRead: cached,
                  cacheWrite: 0,
                  output: usage.output_tokens,
                  cost: null,
                },
              },
            });
        }
        observer.record({
          unavailable: "Codex child assignment/usage coverage is unknown",
          parent: value.usage,
        });
      }
      continue;
    }
    if (
      value.type === "message_end" &&
      typeof value.message === "object" &&
      value.message !== null
    ) {
      const message = value.message as Record<string, unknown>;
      if (message.role !== "assistant") continue;
      const id = `response-${++response}`;
      observer.record({
        kind: "response",
        attempt: coordinator,
        response: id,
        state:
          message.stopReason === "aborted" || message.stopReason === "error"
            ? "interrupted"
            : "completed",
      });
      const usage = message.usage as Record<string, unknown> | undefined;
      if (usage)
        observer.record({
          kind: "usage",
          observation: {
            attempt: coordinator,
            source: id,
            kind: "response",
            responseId: id,
            usage: {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              cost:
                typeof usage.cost === "object" && usage.cost !== null
                  ? (usage.cost as Record<string, unknown>).total
                  : null,
            },
          },
        });
      completed = message.stopReason === "stop";
    }
  }
  return completed;
}
export async function runAdapter(context: AdapterContext): Promise<AdapterResult> {
  if (context.adapter.kind === "offline") return offline(context, context.adapter.mode);
  const observer = new Observer();
  const coordinator = `${context.attempt}/coordinator`;
  observer.record(
    {
      kind: "start",
      run: context.cell,
      worker: "coordinator",
      assignment: 1,
      attempt: coordinator,
    },
    "supervisor",
  );
  const request = {
    schemaVersion: 1,
    cell: context.cell,
    attempt: context.attempt,
    candidate: context.candidate,
    evidenceDirectory: context.directory,
    task: {
      id: context.task.task.id,
      version: context.task.task.version,
      prompt: context.task.task.prompt,
      units: context.task.task.units,
    },
    requested: context.requested,
    limits: context.limits,
    coordinatorAttempt: coordinator,
  };
  const requestFile = join(
    context.directory,
    context.adapter.kind === "native" ? "native-request.json" : "request.json",
  );
  await writeFile(requestFile, JSON.stringify(request), { flag: "wx", mode: 0o600 });
  const invocation =
    context.adapter.kind === "native"
      ? nativeInvocation(context)
      : {
          command: context.adapter.command,
          args: [...context.adapter.args, requestFile],
          env: undefined,
        };
  const execution = await runProcess({
    directory: join(context.directory, "adapter-supervisor"),
    ...invocation,
    cwd: context.candidate,
    limits: context.limits,
    store: context.store,
    signal: context.signal,
  });
  const reasons: string[] = execution.failure ? [execution.failure] : [];
  let completed = false;
  let observed: Condition | null = null;
  if (context.adapter.kind === "external") {
    try {
      const response = adapterResponseSchema.parse(JSON.parse(execution.stdout.toString()));
      completed = response.completed;
      observed = response.observed;
      for (const record of response.observations) observer.record(record);
      reasons.push(...response.limitations, "Observed adapter settings are self-reported");
    } catch (error) {
      observer.record({ malformed: "Adapter response invalid" });
      reasons.push(String(error));
    }
  } else {
    completed = nativeStream(execution.stdout, context.adapter.system, observer, coordinator);
    if (context.adapter.system === "pinata") {
      try {
        await collectPinataEvidence(join(context.directory, "runtime"), observer);
      } catch (error) {
        observer.record({ malformed: "Pinata run evidence unavailable" });
        reasons.push(String(error));
      }
    }
    reasons.push(
      "Requested model/backend/tool settings require independent observation; native condition remains unverified",
    );
  }
  observer.record({
    kind: "settled",
    attempt: coordinator,
    complete: completed && execution.state === "completed",
  });
  const state =
    execution.state !== "completed"
      ? execution.state
      : execution.exit.code === 0 && completed
        ? "completed"
        : "failed";
  return {
    state,
    observed,
    records: observer.records,
    evidence: [await context.store.json(request), ...execution.evidence],
    cleanup: execution.cleanup,
    reasons,
    snapshots: [],
  };
}
