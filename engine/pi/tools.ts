import { discoverAgents } from "./definitions.ts";
// The model-facing tools. Delegation creates and starts a run in one call (pinata_run).
// Repair, integration and rollback are added by the builder pipeline (M3).
import { open } from "node:fs/promises";
import { join } from "node:path";
import { Type, type TSchema } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BACKENDS, COST_MAX, LIMIT_MAX, THINKING_LEVELS } from "../core/types.ts";
import { statusText, progressLine } from "../ui/text.ts";
import {
  compactRun,
  compactTask,
  repositoryRoot,
  type PinataHost,
  type RunParams,
} from "./host.ts";
import { deliverWhenDone } from "./delivery.ts";
import { integrate, rollback } from "../verify/integrate.ts";
import { handoff } from "../verify/evidence.ts";
import {
  verifyDestination,
  verificationStatus,
  type VerificationOptions,
} from "../verify/destination.ts";
import { integrationStatus } from "./ui.ts";
import { ValidationError } from "../core/validate.ts";
import type { Settled } from "../core/engine.ts";

const object = (fields: Record<string, TSchema>, options: Record<string, unknown> = {}) =>
  Type.Object(fields, { additionalProperties: false, ...options });
const optional = <T extends TSchema>(schema: T) => Type.Optional(schema);
const string = (description?: string) =>
  Type.String({ minLength: 1, maxLength: 64_000, ...(description && { description }) });
const strings = (description?: string) => Type.Array(string(), description ? { description } : {});
const choices = (values: readonly string[], description?: string) =>
  Type.Union(
    values.map((v) => Type.Literal(v)),
    description ? { description } : {},
  );
const taskId = (description?: string) =>
  Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$", ...(description && { description }) });

export function schemas() {
  const model = object({ provider: string(), id: string(), thinking: choices(THINKING_LEVELS) });
  const check = object({
    id: taskId(),
    argv: Type.Array(string(), { minItems: 1 }),
    timeoutMs: optional(Type.Integer({ minimum: 1, maximum: 1_200_000 })),
  });
  const task = object({
    id: taskId(),
    agent: optional(taskId("Agent name from pinata_agents. Presets: scout, builder, reviewer.")),
    role: optional(string("Deprecated alias for agent.")),
    task: string(),
    acceptance: optional(Type.Array(string(), { minItems: 1 })),
    instructions: optional(strings()),
    context: optional(strings("Quoted evidence for the agent; not instructions.")),
    after: optional(
      Type.Array(taskId(), {
        description: "Dependencies. Their results are inlined into this task's first message.",
      }),
    ),
    ownership: optional(
      strings(
        "Builders only (required for them): repo-relative files or directory prefixes the builder may change.",
      ),
    ),
    checks: optional(
      Type.Array(check, { description: "Builders only: commands that verify the change." }),
    ),
    evidenceChecks: optional(
      Type.Array(check, {
        description:
          "Any role: targeted, non-mutating commands for consequential factual claims, run after the agent finishes.",
      }),
    ),
    noChecksReason: optional(string("Builders only: why a builder has no checks.")),
    reviewOf: optional(
      taskId("Reviewers only: the builder task under review, also listed in after."),
    ),
    reviewBase: optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          "Reviewers only, instead of reviewOf: review the live checkout (uncommitted changes included) against this Git revision. HEAD reviews only uncommitted changes.",
      }),
    ),
    reviewPr: optional(
      Type.Integer({
        minimum: 1,
        description: "Reviewers only, instead of reviewOf: a GitHub pull request number.",
      }),
    ),
    model: optional(model),
    backend: optional(choices(BACKENDS, "Where the agent runs. Default in-process.")),
  });
  const limits = object({
    ...Object.fromEntries(
      Object.entries(LIMIT_MAX).map(([key, max]) => [
        key,
        optional(Type.Integer({ minimum: 1, maximum: max })),
      ]),
    ),
    costUsd: optional(
      Type.Number({
        exclusiveMinimum: 0,
        maximum: COST_MAX,
        description: "Stop the run once agents have spent this many US dollars.",
      }),
    ),
  });
  const config = object({
    models: optional(Type.Record(string(), model)),
    fallbacks: optional(Type.Record(string(), Type.Array(model, { maxItems: 5 }))),
    toolProviders: optional(
      Type.Record(string(), object({ extension: string(), tools: strings() })),
    ),
    limits: optional(limits),
    passEnv: optional(strings()),
    webExtension: optional(string()),
    setup: optional(Type.Union([Type.Literal(false), string()])),
    worktreeRoot: optional(
      string("External directory for new worktrees; defaults to the user data directory."),
    ),
    codemode: optional(Type.Boolean()),
    includeUncommitted: optional(Type.Boolean()),
    mode: optional(choices(["lean", "observe"])),
    backend: optional(choices(BACKENDS)),
  });
  const run = string("The run id (or a unique prefix).");
  return {
    run: object({
      tasks: Type.Array(task, { minItems: 1 }),
      background: optional(
        Type.Boolean({
          description: "Return at once; the result arrives later as a follow-up message.",
        }),
      ),
      survive: optional(
        Type.Boolean({
          description:
            "With background:true, keep the run going if Pi exits (agents run as separate processes).",
        }),
      ),
      cwd: optional(string()),
      approval: optional(
        string(
          "Required when any builder is present: the user's authorization for these local writes.",
        ),
      ),
      instructions: optional(strings("Instructions for every task.")),
      config: optional(config),
      integratedChecks: optional(Type.Array(check)),
      noIntegratedChecksReason: optional(string()),
    }),
    status: object({
      run: optional(run),
      offset: optional(Type.Integer({ minimum: 0 })),
      limit: optional(Type.Integer({ minimum: 1, maximum: 64 })),
      task: optional(taskId()),
      detail: optional(choices(["summary", "result", "transcript"])),
    }),
    steer: object({
      run,
      task: taskId(),
      message: string(),
      as: optional(choices(["steer", "followUp"])),
    }),
    cancel: object({ run, task: optional(taskId()) }),
    repair: object({
      run,
      task: taskId(),
      feedback: string("What to fix, from the review or failure."),
    }),
    integrate: object({ run }),
    changes: object({ run }),
    verify: object({
      run,
      checks: optional(Type.Array(check)),
      noChecksReason: optional(string()),
    }),
    rollback: object({ run, confirm: Type.Literal(true) }),
  };
}

export const DESCRIPTIONS = {
  run: "Delegate bounded tasks to pinata agents and run them now. Choose scout, builder, reviewer, or an installed custom definition; pinata_agents lists them. Writers change owned files in isolated worktrees. Foreground by default: waits, streams progress and returns compact results. background:true returns the run id and delivers the results later as a follow-up message; do not poll. approval is required when any builder is present.",
  status:
    'Read pinata status: the latest run, a run, or one task. detail:"result" returns a task\'s full result; detail:"transcript" returns a bounded transcript excerpt and the file path. Read-only; do not poll running runs.',
  steer:
    "Send a message to a running agent: steer (after its current turn) or followUp (after it finishes its current work). Recorded and shown to reviewers.",
  cancel:
    "Cancel a run or one of its agents. Cancelled agents settle as cancelled; nothing else is undone.",
  repair:
    "Re-run a builder in its worktree with feedback (from a rejected review or a failure), within limits.repairs. Its reviewers run again on the new change. Waits for the result.",
  integrate:
    "Optionally apply approved builder artifacts exactly and run destination checks. The orchestrator calls this; never automatic. HEAD may advance if affected files still match. Conflicts require pinata_changes and orchestrator reconciliation. Never stages or commits. Builder reviews remain scoped to their original bases.",
  changes:
    "Return verified builder artifacts, recorded bases, checks, reviews and immutable patches for orchestrator-owned integration. Does not change the destination checkout. Evidence is about the original artifacts, not the current destination.",
  verify:
    "Run checks on the current destination without applying builder changes. Uses the run's integratedChecks unless checks is supplied. Records the exact tree and whether it contains the approved outputs. Does not grant independent review or claim reconciliation is correct. No checks means not_run, not verified.",
  rollback:
    "Restore the checkout from the run's integration journal, where files still match what integration wrote. Needs confirm:true.",
};

type ToolResult = AgentToolResult<Record<string, unknown>>;

export function ok(value: unknown, text = JSON.stringify(value)): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: { result: value },
    structuredContent: { result: value } as never,
  };
}

export function fail(error: unknown): ToolResult {
  const result = { error: (error as Error)?.message ?? String(error) };
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result,
    structuredContent: { result } as never,
    isError: true,
  };
}

function renderTranscript(lines: string[], max = 6000): string {
  const out: string[] = [];
  for (const raw of lines) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      continue;
    }
    const text = (c: any) =>
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c
              .map((x: any) =>
                x.type === "text"
                  ? x.text
                  : x.type === "toolCall"
                    ? `[${x.name} ${JSON.stringify(x.arguments).slice(0, 200)}]`
                    : "",
              )
              .join(" ")
          : "";
    out.push(
      `${m.role}${m.toolName ? ` ${m.toolName}` : ""}: ${text(m.content).replace(/\s+/g, " ").slice(0, 600)}`,
    );
  }
  const joined = out.join("\n");
  return joined.length > max ? `…${joined.slice(joined.length - max)}` : joined;
}

export async function statusTool(
  host: PinataHost,
  params: { run?: string; task?: string; detail?: string; offset?: number; limit?: number },
  ctx: ExtensionContext,
) {
  let target: Awaited<ReturnType<PinataHost["find"]>>;
  if (params.run) target = await host.find(params.run, ctx.cwd);
  else {
    const latest = [...host.handles.values()].at(-1);
    if (latest) target = { id: latest.id, dir: latest.dir, view: latest.view(), handle: latest };
    else {
      const [view] = await host.history(ctx.cwd, 1);
      if (!view) return { runs: 0, text: "No pinata runs in this repository." };
      target = await host.find(view.run, ctx.cwd);
    }
  }
  const { view, dir } = target;
  if (!params.task) {
    const results = target.handle?.results() ?? new Map<string, Settled>();
    if (!target.handle) {
      // Hydrate only the requested page. Historical status carries the same recorded
      // evidence as a live handle without reading every result in a large run.
      const offset = Math.max(0, Math.floor(params.offset ?? 0));
      const limit = Math.max(1, Math.min(64, Math.floor(params.limit ?? 64)));
      await Promise.all(
        view.order.slice(offset, offset + limit).map(async (id) => {
          if (["queued", "running"].includes(view.agents[id].status)) return;
          const saved = (await host.readResult(dir, id)) as Settled | null;
          if (saved) (results as Map<string, Settled>).set(id, saved);
        }),
      );
    }
    return {
      ...compactRun(view, dir, results, [], params),
      integration: await integrationStatus(dir),
      verification: await verificationStatus(dir),
      text: view.order.length > 64 ? progressLine(view) : statusText(view),
    };
  }
  if (!view.agents[params.task]) throw new Error(`Unknown task ${params.task} in run ${view.run}`);
  const saved = (await host.readResult(dir, params.task)) as Record<string, any> | null;
  if (params.detail === "result")
    return {
      run: view.run,
      task: params.task,
      definition: view.agents[params.task].definition,
      ...(saved ?? { status: view.agents[params.task].status }),
    };
  if (params.detail === "transcript") {
    const file = join(dir, "transcripts", `${params.task}.jsonl`);
    const raw = await (async () => {
      const handle = await open(file, "r").catch(() => null);
      if (!handle) return "";
      try {
        const size = (await handle.stat()).size;
        const start = Math.max(0, size - 64 * 1024);
        const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        const tail = buffer.subarray(0, bytesRead).toString("utf8");
        return start ? tail.slice(tail.indexOf("\n") + 1) : tail;
      } finally {
        await handle.close();
      }
    })();
    return {
      run: view.run,
      task: params.task,
      transcript: file,
      excerpt: raw
        ? renderTranscript(raw.trim().split("\n"))
        : "(no transcript yet: lean mode writes it when the agent settles)",
    };
  }
  return compactTask(
    params.task,
    view,
    saved ? { ...(saved as any), result: saved.result ?? null } : undefined,
  );
}

export function registerTools(pi: ExtensionAPI, host: PinataHost): void {
  const s = schemas();
  pi.registerTool({
    name: "pinata_agents",
    label: "Pinata agents",
    description:
      "List available agent definitions, or inspect one agent's instructions, tools, workspace, defaults, and source.",
    parameters: object({ name: optional(taskId()) }),
    annotations: { readOnlyHint: true },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      try {
        const agents = discoverAgents(await repositoryRoot(ctx.cwd).catch(() => ctx.cwd));
        if (input.name) {
          const definition = agents.get(String(input.name));
          if (!definition) throw new ValidationError(`Unknown agent ${input.name}`);
          return ok(definition);
        }
        return ok(
          [...agents.values()].map(({ name, description, workspace, source, digest }) => ({
            name,
            description,
            workspace,
            source,
            digest,
          })),
        );
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_run",
    label: "Pinata run",
    description: DESCRIPTIONS.run,
    parameters: s.run,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: false },
    async execute(_id, input, signal, onUpdate, ctx) {
      const params = input as unknown as RunParams;
      try {
        if (params.survive && !params.background)
          throw new ValidationError("survive:true needs background:true");
        const { handle, notices } = await host.start(params, ctx);
        if (params.background) {
          host.background.add(handle.id);
          deliverWhenDone(pi, host, handle, notices);
          return ok({
            run: handle.id,
            dir: handle.dir,
            status: "running",
            background: true,
            notices,
          });
        }
        const view = await host.foreground(handle, signal, (text, v) =>
          onUpdate?.({
            content: [{ type: "text", text }],
            details: { run: v.run, status: v.status },
          }),
        );
        return ok(compactRun(view, handle.dir, handle.results(), notices));
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_status",
    label: "Pinata status",
    description: DESCRIPTIONS.status,
    parameters: s.status,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: true },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const params = input as { run?: string; task?: string; detail?: string };
      try {
        return ok(await statusTool(host, params, ctx));
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_steer",
    label: "Pinata steer",
    description: DESCRIPTIONS.steer,
    parameters: s.steer,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: false },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const params = input as {
        run: string;
        task: string;
        message: string;
        as?: "steer" | "followUp";
      };
      try {
        const { id } = await host.find(params.run, ctx.cwd);
        await host
          .engine(ctx)
          .steer(id, params.task, params.message, params.as ?? "steer", "parent");
        return ok({ run: id, task: params.task, steered: params.as ?? "steer" });
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_repair",
    label: "Pinata repair",
    description: DESCRIPTIONS.repair,
    parameters: s.repair,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: false },
    async execute(_id, input, signal, onUpdate, ctx) {
      const params = input as { run: string; task: string; feedback: string };
      try {
        const { id, handle } = await host.find(params.run, ctx.cwd);
        if (!handle) throw new Error(`Run ${id} is not in this session; start a new run`);
        host.engine(ctx).repair(id, params.task, params.feedback);
        const view = await host.foreground(handle, signal, (text, v) =>
          onUpdate?.({
            content: [{ type: "text", text }],
            details: { run: v.run, status: v.status },
          }),
        );
        return ok(compactRun(view, handle.dir, handle.results()));
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_changes",
    label: "Pinata changes",
    description: DESCRIPTIONS.changes,
    parameters: s.changes,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: true },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      try {
        const { dir, view } = await host.find((input as { run: string }).run, ctx.cwd);
        if (view.status !== "succeeded")
          throw new Error("Wait for every task and review to succeed before handoff");
        return ok(await handoff(dir));
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_verify",
    label: "Pinata verify destination",
    description: DESCRIPTIONS.verify,
    parameters: s.verify,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: false },
    async execute(_id, input, signal, _onUpdate, ctx) {
      try {
        const params = input as unknown as { run: string } & VerificationOptions;
        const { id, dir, view } = await host.find(params.run, ctx.cwd);
        if (view.status !== "succeeded")
          throw new Error("Wait for every task and review to succeed before verification");
        const result = await verifyDestination(dir, params, signal);
        host.ui?.integrated(
          id,
          result.status === "verified" ? "destination_checked" : result.status,
        );
        return ok({ run: id, ...result });
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_integrate",
    label: "Pinata integrate",
    description: DESCRIPTIONS.integrate,
    parameters: s.integrate,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    async execute(_id, input, signal, _onUpdate, ctx) {
      const params = input as { run: string };
      try {
        const { id, dir, view } = await host.find(params.run, ctx.cwd);
        if (view.status !== "succeeded")
          throw new Error("Wait for every task and review to succeed before integration");
        const result = await integrate(dir, signal);
        host.ui?.integrated(id, result.status);
        return ok({ run: id, ...result });
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_rollback",
    label: "Pinata rollback",
    description: DESCRIPTIONS.rollback,
    parameters: s.rollback,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const params = input as { run: string; confirm: boolean };
      try {
        if (params.confirm !== true) throw new Error("Rollback needs confirm:true");
        const { id, dir } = await host.find(params.run, ctx.cwd);
        const result = await rollback(dir);
        host.ui?.integrated(id, result.status);
        return ok({ run: id, ...result });
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_cancel",
    label: "Pinata cancel",
    description: DESCRIPTIONS.cancel,
    parameters: s.cancel,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const params = input as { run: string; task?: string };
      try {
        const { id, handle } = await host.find(params.run, ctx.cwd);
        if (!handle) throw new Error(`Run ${id} is not running in this session`);
        await host.engine(ctx).cancel(id, params.task);
        return ok({ run: id, ...(params.task && { task: params.task }), cancelled: true });
      } catch (error) {
        return fail(error);
      }
    },
  });
}
