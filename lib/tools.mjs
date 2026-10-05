import * as api from "./pinata.mjs";
import { loadRun } from "./run.mjs";
import { outcome } from "./evidence.mjs";
import { ROLES, TERMINAL, LIMIT_MAX, checkedKeys, need, text } from "./core.mjs";

// Type is supplied by Pi. The orchestration library has no runtime dependency
// on Pi's SDK, so the CLI and these handlers can also run outside Pi.
export function toolSchemas(Type) {
  const object = (fields) => Type.Object(fields, { additionalProperties: false });
  const optional = (schema) => Type.Optional(schema);
  const string = () => Type.String({ minLength: 1, maxLength: 64_000 });
  const strings = () => Type.Array(string());
  const choices = (values) => Type.Union(values.map((v) => Type.Literal(v)));
  const taskId = () => Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" });
  const model = object({
    provider: string(),
    id: string(),
    thinking: choices(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  });
  const check = object({
    id: taskId(),
    argv: Type.Array(string(), { minItems: 1 }),
    timeoutMs: optional(Type.Integer({ minimum: 1, maximum: 1_200_000 })),
  });
  const task = object({
    id: taskId(),
    role: choices(ROLES),
    task: string(),
    acceptance: Type.Array(string(), { minItems: 1 }),
    instructions: optional(strings()),
    context: optional(strings()),
    ownership: optional(strings()),
    after: optional(Type.Array(taskId())),
    reviewOf: optional(taskId()),
    checks: optional(Type.Array(check)),
    noChecksReason: optional(string()),
    model: optional(model),
  });
  const config = object({
    pi: optional(string()),
    herdr: optional(string()),
    session: optional(string()),
    webExtension: optional(string()),
    models: optional(
      object(Object.fromEntries(["default", ...ROLES].map((r) => [r, optional(model)]))),
    ),
    fallbacks: optional(
      object(
        Object.fromEntries(ROLES.map((r) => [r, optional(Type.Array(model, { maxItems: 5 }))])),
      ),
    ),
    limits: optional(
      object(
        Object.entries(LIMIT_MAX).reduce(
          (o, [key, max]) => ({
            ...o,
            [key]: optional(Type.Integer({ minimum: 1, maximum: max })),
          }),
          {},
        ),
      ),
    ),
    passEnv: optional(strings()),
    setup: optional(Type.Union([Type.Literal(false), string()])),
    codemode: optional(Type.Boolean()),
  });
  const run = string();
  return {
    delegate: object({
      cwd: optional(string()),
      approval: string(),
      allowWrites: optional(Type.Boolean()),
      instructions: optional(strings()),
      config: optional(config),
      tasks: Type.Array(task, { minItems: 1 }),
      integratedChecks: optional(Type.Array(check)),
      noIntegratedChecksReason: optional(string()),
    }),
    control: object({
      run,
      action: choices(["start", "resume", "cancel", "cleanup"]),
      confirm: optional(Type.Boolean()),
      yield: optional(Type.Boolean()),
    }),
    yield: object({ run }),
    status: object({ run, includeResults: optional(Type.Boolean()) }),
    add: object({ run, tasks: Type.Array(task, { minItems: 1 }) }),
    repair: object({ run, taskId: taskId(), feedback: string() }),
    barrier: object({ run, taskIds: Type.Array(taskId(), { minItems: 1 }) }),
    integrate: object({ run }),
    rollback: object({ run, confirm: Type.Literal(true) }),
    gc: object({ cwd: optional(string()), confirm: optional(Type.Boolean()) }),
  };
}

const descriptions = {
  delegate:
    "Prepare complementary bounded tasks after required repository orientation. Scout owns local architecture; research answers specific external/version questions rather than repeating the scout's map. The parent synthesizes and spot-checks worker evidence. Returns setup/models; inspect then start and yield immediately. Records existing authorization; launches nothing. cwd defaults to Pi's cwd.",
  control:
    "Start background orchestration, resume reconciliation, cancel owned work, or preview cleanup. Start alone outside codemode and yield immediately by default; native completion resumes you later. Use yield:false only for a concrete separate task that does not repeat worker investigation, then pinata_yield. Broad repository reading is not independent work. Never poll while waiting. Start again after add/repair or pending delivery. Cleanup removes verified owned resources only with confirm:true.",
  yield:
    "End the current Pi turn while a started Pinata job runs. Completion automatically resumes you in a later turn. Call this tool alone, outside codemode, after independent work; do not poll or sleep. Does not cancel workers.",
  status:
    "Read saved pinata status, models/thinking, elapsed time, tokens and failures. includeResults revalidates and reads outcomes. Use after a completion notification, for recovery, or when the user asks about progress. Do not repeatedly poll running workers: use pinata_yield instead. Does not schedule work.",
  add: "Add bounded tasks to an existing job using the same scope, dependency and ownership validation. Inspect any newly resolved builder setup, then start the coordinator.",
  repair:
    "Queue feedback for a terminal task, preserve retained work and invalidate dependent reviews. Uses the existing repair budget. Start afterward.",
  barrier:
    "Revalidate successful evidence for every required task before downstream work. Fails if any task is missing, unsuccessful or stale.",
  integrate:
    "Apply reviewed builder changes locally and run integrated checks. Requires current approving review for every builder and existing authorization. Returns verification status; does not commit.",
  rollback:
    "Restore the latest integration journal where current contents still match the recorded integration. Requires explicit confirm:true and existing authorization.",
  gc: "Inspect all Pinata runs in a repository and preview retirement of finished owned panes and disposable worktrees. Reports a reason for each retained resource. With confirm:true, revalidate and remove eligible resources while archiving outcome digests and preserving logs/results. Requires existing authorization for removal. Never schedules work or controls unrelated resources. cwd defaults to Pi's cwd.",
};

export async function executeTool(name, params, ctx, pi, signal, completion) {
  need(!process.env.PINATA_WORKER, "Recursive pinata orchestration is disabled for workers");
  need(!signal?.aborted, "Tool call cancelled before execution");
  const fields = {
    delegate: [
      "cwd",
      "approval",
      "allowWrites",
      "instructions",
      "config",
      "tasks",
      "integratedChecks",
      "noIntegratedChecksReason",
    ],
    control: ["run", "action", "confirm", "yield"],
    yield: ["run"],
    status: ["run", "includeResults"],
    add: ["run", "tasks"],
    repair: ["run", "taskId", "feedback"],
    barrier: ["run", "taskIds"],
    integrate: ["run"],
    rollback: ["run", "confirm"],
    gc: ["cwd", "confirm"],
  };
  need(fields[name], "Unknown pinata tool");
  checkedKeys(params, fields[name], "tool parameters");
  if (name === "gc") {
    need(
      params.confirm === undefined || typeof params.confirm === "boolean",
      "Invalid GC confirmation",
    );
    return api.gc(params.cwd ?? ctx.cwd, params.confirm ?? false);
  }
  if (name === "delegate") {
    need(Array.isArray(params.tasks) && params.tasks.length > 0, "Tasks required");
    const inheritedModel = ctx.model && {
      provider: ctx.model.provider,
      id: ctx.model.id,
      thinking: pi.getThinkingLevel(),
    };
    return api.init({ ...params, cwd: params.cwd ?? ctx.cwd }, { inheritedModel });
  }
  text(params.run, "run directory");
  if (name === "control") {
    need(
      ["start", "resume", "cancel", "cleanup"].includes(params.action),
      "Unknown control action",
    );
    need(params.confirm === undefined || typeof params.confirm === "boolean", "Invalid confirm");
    need(
      params.action === "cleanup" || params.confirm === undefined,
      "confirm applies only to cleanup",
    );
    need(params.yield === undefined || typeof params.yield === "boolean", "Invalid yield");
    need(params.action === "start" || params.yield === undefined, "yield applies only to start");
    if (params.action === "start" && completion)
      return completion.start(params.run, ctx, params.yield !== false);
    return params.action === "cleanup"
      ? api.cleanup(params.run, params.confirm ?? false)
      : params.action === "resume"
        ? api.tick(params.run)
        : api[params.action](params.run);
  }
  if (name === "yield") {
    need(completion, "Yield requires the Pinata Pi extension");
    return completion.yield(params.run, ctx);
  }
  if (name === "status") {
    need(
      params.includeResults === undefined || typeof params.includeResults === "boolean",
      "Invalid includeResults",
    );
    const run = await loadRun(params.run);
    const status = api.summary(run);
    if (params.includeResults) {
      status.outcomes = {};
      for (const task of run.tasks.filter((t) => t.attempts.length && TERMINAL.includes(t.status)))
        status.outcomes[task.spec.id] = await outcome(run, task).catch((e) => ({
          error: e.message,
        }));
    }
    return status;
  }
  if (name === "add") {
    need(Array.isArray(params.tasks) && params.tasks.length > 0, "Tasks required");
    return api.add(params.run, params.tasks);
  }
  if (name === "repair") return api.repair(params.run, params.taskId, params.feedback);
  if (name === "barrier") {
    need(Array.isArray(params.taskIds) && params.taskIds.length > 0, "Task IDs required");
    return api.barrier(params.run, params.taskIds);
  }
  if (name === "rollback") need(params.confirm === true, "Rollback requires confirm:true");
  return api[name](params.run);
}

export function registerTools(pi, Type, completion) {
  if (process.env.PINATA_WORKER) return;
  for (const [name, parameters] of Object.entries(toolSchemas(Type)))
    pi.registerTool({
      name: `pinata_${name}`,
      label: `Pinata ${name}`,
      description: descriptions[name],
      parameters,
      outputSchema: Type.Object({ result: Type.Unknown() }),
      ...(name === "yield" ? { exposure: "model-only" } : {}),
      annotations: { readOnlyHint: ["status", "barrier"].includes(name) },
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const result = await executeTool(name, params, ctx, pi, signal, completion);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            structuredContent: { result },
            ...((name === "yield" || (name === "control" && params.action === "start")) &&
            result.waiting
              ? { terminate: true }
              : {}),
          };
        } catch (e) {
          const result = { error: e.message };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            structuredContent: { result },
            isError: true,
          };
        }
      },
    });
}
