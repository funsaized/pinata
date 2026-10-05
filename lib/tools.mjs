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
    }),
    status: object({ run, includeResults: optional(Type.Boolean()) }),
    add: object({ run, tasks: Type.Array(task, { minItems: 1 }) }),
    repair: object({ run, taskId: taskId(), feedback: string() }),
    barrier: object({ run, taskIds: Type.Array(taskId(), { minItems: 1 }) }),
    integrate: object({ run }),
    rollback: object({ run, confirm: Type.Literal(true) }),
  };
}

const descriptions = {
  delegate:
    "Prepare a bounded pinata job in isolated Git worktrees. Records existing user authorization; approval text does not grant permission. Returns setup and resolved models for inspection before pinata_control start. Does not launch workers. cwd defaults to the current Pi directory.",
  control:
    "Start background orchestration, resume reconciliation after interruption, cancel owned work, or preview cleanup. Cleanup removes verified owned resources only when confirm is true. Start again after add/repair or pending completion delivery.",
  status:
    "Read saved pinata status, effective models/thinking and origins, elapsed time, tokens and failure stages. includeResults also revalidates and reads available outcomes. Does not schedule work.",
  add: "Add bounded tasks to an existing job using the same scope, dependency and ownership validation. Inspect any newly resolved builder setup, then start the coordinator.",
  repair:
    "Queue feedback for a terminal task, preserve retained work and invalidate dependent reviews. Uses the existing repair budget. Start afterward.",
  barrier:
    "Revalidate successful evidence for every required task before downstream work. Fails if any task is missing, unsuccessful or stale.",
  integrate:
    "Apply reviewed builder changes locally and run integrated checks. Requires current approving review for every builder and existing authorization. Returns verification status; does not commit.",
  rollback:
    "Restore the latest integration journal where current contents still match the recorded integration. Requires explicit confirm:true and existing authorization.",
};

export async function executeTool(name, params, ctx, pi, signal) {
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
    control: ["run", "action", "confirm"],
    status: ["run", "includeResults"],
    add: ["run", "tasks"],
    repair: ["run", "taskId", "feedback"],
    barrier: ["run", "taskIds"],
    integrate: ["run"],
    rollback: ["run", "confirm"],
  };
  need(fields[name], "Unknown pinata tool");
  checkedKeys(params, fields[name], "tool parameters");
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
    return params.action === "cleanup"
      ? api.cleanup(params.run, params.confirm ?? false)
      : params.action === "resume"
        ? api.tick(params.run)
        : api[params.action](params.run);
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

export function registerTools(pi, Type) {
  if (process.env.PINATA_WORKER) return;
  for (const [name, parameters] of Object.entries(toolSchemas(Type)))
    pi.registerTool({
      name: `pinata_${name}`,
      label: `Pinata ${name}`,
      description: descriptions[name],
      parameters,
      outputSchema: Type.Object({ result: Type.Unknown() }),
      annotations: { readOnlyHint: ["status", "barrier"].includes(name) },
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const result = await executeTool(name, params, ctx, pi, signal);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            structuredContent: { result },
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
