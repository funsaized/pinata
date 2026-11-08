import { discoverAgents } from "./definitions.ts";
// The model-facing tools. Delegation creates and starts a run in one call (pinata_run).
// Optional application and rollback share the checkout exclusion and journal.
import { open } from "node:fs/promises";
import { join } from "node:path";
import { Type, type TSchema } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BACKENDS, THINKING_LEVELS } from "../core/types.ts";
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
import { verificationStatus } from "../verify/destination.ts";
import { integrationStatus } from "./ui.ts";
import { ValidationError } from "../core/validate.ts";
import type { Settled } from "../core/engine.ts";
import { toolRenderers } from "./render.ts";

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
  const task = object({
    id: taskId(),
    agent: optional(taskId("Agent name from pinata_agents. Presets: scout, builder, reviewer.")),
    role: optional(string("Deprecated alias for agent.")),
    task: string(),
    acceptance: optional(Type.Array(string(), { minItems: 1 })),
    instructions: optional(strings()),
    context: optional(strings("Quoted evidence for the agent; not instructions.")),
    after: optional(
      Type.Array(
        Type.Union([
          taskId(),
          object({ worker: taskId(), assignment: Type.Integer({ minimum: 1 }) }),
        ]),
        {
          description: "Dependencies. Their results are inlined into this task's first message.",
        },
      ),
    ),
    workspace: optional(choices(["shared", "worktree"])),
    inputs: optional(
      Type.Array(object({ worker: taskId(), assignment: Type.Integer({ minimum: 1 }) })),
    ),
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
  const config = object({
    workspace: optional(choices(["shared", "worktree"])),
    models: optional(Type.Record(string(), model)),
    fallbacks: optional(Type.Record(string(), Type.Array(model, { maxItems: 5 }))),
    toolProviders: optional(
      Type.Record(string(), object({ extension: string(), tools: strings() })),
    ),
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
      run: optional(run),
      workspace: optional(choices(["shared", "worktree"])),
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
      approval: optional(string("Record the user authorization for local writes when useful.")),
      instructions: optional(
        strings(
          "Instructions for every task; combined caller and trusted host instructions are limited to 128 KiB and never truncated.",
        ),
      ),
      config: optional(config),
    }),
    status: object({
      run: optional(run),
      offset: optional(Type.Integer({ minimum: 0 })),
      limit: optional(Type.Integer({ minimum: 1, maximum: 64 })),
      task: optional(taskId()),
      assignment: optional(Type.Integer({ minimum: 1 })),
      detail: optional(choices(["summary", "result", "transcript"])),
    }),
    steer: object({
      run,
      task: taskId(),
      message: string(),
      as: optional(choices(["steer", "followUp"])),
      messageId: optional(string("Stable retry ID. Reusing it returns the same durable request.")),
    }),
    cancel: object({ run, task: optional(taskId()) }),
    wait: object({ run, tasks: optional(Type.Array(taskId())), next: optional(Type.Boolean()) }),
    integrate: object({
      run,
      recover: optional(
        Type.Boolean({
          description:
            "Explicitly reconcile an interrupted application whose recorded local process is dead.",
        }),
      ),
      selected: optional(
        Type.Array(object({ worker: taskId(), assignment: Type.Integer({ minimum: 1 }) })),
      ),
    }),
    changes: object({
      run,
      selected: optional(
        Type.Array(object({ worker: taskId(), assignment: Type.Integer({ minimum: 1 }) })),
      ),
    }),
    rollback: object({ run, confirm: Type.Literal(true), recover: optional(Type.Boolean()) }),
  };
}

export const DESCRIPTIONS = {
  run: "Start workers now, or add workers to an existing run with run. Shared checkout by default; workspace:worktree selects isolation. Assign file responsibilities in task text. after controls execution order, including failed predecessors. Background work delivers assignment completions automatically; yield when waiting.",
  status:
    "Inspect worker execution, assignments, workspaces, results and observed usage. Full results/transcripts remain on disk; status is paginated.",
  steer:
    "Durably record a message. steer addresses active or initial queued work. followUp queues the next assignment or continues an idle, failed or cancelled worker in its saved context and workspace. Return includes a stable message ID and delivery state; queue acceptance is not consumption.",
  cancel:
    "Cancel selected workers or the run, stop owned activity, and preserve all workspace edits and saved evidence.",
  integrate:
    "Apply selected saved isolated snapshots to a quiescent checkout with conflict checks and a recovery journal. Follow-ups apply only the delta since the prior applied snapshot. Never stages or commits; application asserts no test or review result.",
  changes:
    "Inspect shared checkout state and saved isolated patches independently of run success or optional reports. Shared state may include user and other workers' changes.",
  rollback:
    "Restore the latest application journal where destination files still match; confirm:true is required.",
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
  params: {
    run?: string;
    task?: string;
    assignment?: number;
    detail?: string;
    offset?: number;
    limit?: number;
  },
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
  const saved = (await host.readResult(dir, params.task, params.assignment)) as Record<
    string,
    any
  > | null;
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
    ...toolRenderers("agents"),
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
    ...toolRenderers("run"),
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
        const { handle, notices } = await host.start(params, ctx, signal);
        if (params.background) {
          host.background.add(handle.id);
          deliverWhenDone(pi, host, handle, notices);
          return ok({
            run: handle.id,
            dir: handle.dir,
            status: handle.view().status,
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
    ...toolRenderers("status"),
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
    ...toolRenderers("steer"),
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
        messageId?: string;
      };
      try {
        const found = await host.find(params.run, ctx.cwd);
        const handle = found.handle ?? (await host.resumeDir(found.dir, ctx, true));
        const receipt = await host
          .engine(ctx)
          .steer(
            found.id,
            params.task,
            params.message,
            params.as ?? "steer",
            "parent",
            params.messageId,
          );
        await host.markBackground(handle);
        deliverWhenDone(pi, host, handle);
        return ok({ run: found.id, ...receipt });
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_wait",
    ...toolRenderers("wait"),
    label: "Pinata wait",
    description:
      "Wait for selected workers or the next assignment completion. Cancellation stops waiting; it is not a worker deadline.",
    parameters: s.wait,
    async execute(_id, input, signal, _onUpdate, ctx) {
      try {
        const params = input as { run: string; tasks?: string[]; next?: boolean };
        const found = await host.find(params.run, ctx.cwd);
        const handle = found.handle ?? (await host.resumeDir(found.dir, ctx, true));
        const selected = params.tasks ?? handle.view().order;
        const targets = new Map(
          selected.map((worker) => {
            const agent = handle.view().agents[worker];
            if (!agent) throw new Error(`Unknown worker ${worker}`);
            return [
              worker,
              Math.max(...Object.keys(agent.assignments ?? {}).map(Number), agent.assignment ?? 1),
            ] as const;
          }),
        );
        const ready = () =>
          selected.every((worker) => {
            const agent = handle.view().agents[worker];
            return !["queued", "running"].includes(
              agent.assignments?.[targets.get(worker)!]?.status ?? agent.status,
            );
          });
        if (!ready())
          await new Promise<void>((resolve, reject) => {
            const stop = host.subscribe(handle.id, (event) => {
              if (
                event.t === "agent_settled" &&
                selected.includes(event.agent ?? "") &&
                targets.get(event.agent!) === event.assignment &&
                (params.next || ready())
              ) {
                cleanup();
                resolve();
              }
            });
            const abort = () => {
              cleanup();
              reject(new Error("Wait cancelled; workers continue"));
            };
            const cleanup = () => {
              stop();
              signal?.removeEventListener("abort", abort);
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
            if (ready()) {
              cleanup();
              resolve();
            }
          });
        return ok(compactRun(handle.view(), handle.dir, handle.results()));
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_changes",
    ...toolRenderers("changes"),
    label: "Pinata changes",
    description: DESCRIPTIONS.changes,
    parameters: s.changes,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: true },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      try {
        const { dir, view } = await host.find((input as { run: string }).run, ctx.cwd);
        void view;
        return ok(
          await handoff(
            dir,
            (input as { selected?: import("../core/types.ts").AssignmentRef[] }).selected,
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_integrate",
    ...toolRenderers("integrate"),
    label: "Pinata integrate",
    description: DESCRIPTIONS.integrate,
    parameters: s.integrate,
    outputSchema: Type.Object({ result: Type.Unknown() }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    async execute(_id, input, signal, _onUpdate, ctx) {
      const params = input as { run: string };
      try {
        const { id, dir, view } = await host.find(params.run, ctx.cwd);
        void view;
        const result = await integrate(
          dir,
          signal,
          (input as { selected?: import("../core/types.ts").AssignmentRef[] }).selected,
          { recover: (input as { recover?: boolean }).recover },
        );
        host.ui?.integrated(id, result.status);
        return ok({ run: id, ...result });
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_rollback",
    ...toolRenderers("rollback"),
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
        const result = await rollback(dir, {
          recover: (input as { recover?: boolean }).recover,
          signal: _signal,
        });
        host.ui?.integrated(id, result.status);
        return ok({ run: id, ...result });
      } catch (error) {
        return fail(error);
      }
    },
  });
  pi.registerTool({
    name: "pinata_cancel",
    ...toolRenderers("cancel"),
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
