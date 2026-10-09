// Task and graph validation, ported from 0.7.0's lib/core.mjs (validateTask, validateChecks,
// validateModel, relative, owns) and lib/run.mjs (validateGraph). Errors name the task and field.
import {
  BACKENDS,
  COST_MAX,
  LIMIT_MAX,
  LIMITS,
  ROLES,
  THINKING_LEVELS,
  type Check,
  type Limits,
  type ModelRef,
  type Task,
  type TaskSpec,
} from "./types.ts";

export class ValidationError extends Error {
  override name = "ValidationError";
}

export function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message);
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkedKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  need(isObject(value), `Invalid ${label}`);
  for (const key of Object.keys(value))
    need(allowed.includes(key), `Unknown ${label} field: ${key}`);
}

export function text(value: unknown, name: string, max = 64_000): string {
  need(
    typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0"),
    `Invalid ${name}`,
  );
  return value;
}

export function strings(value: unknown, name: string): string[] {
  need(
    Array.isArray(value) && value.every((v) => typeof v === "string" && !v.includes("\0")),
    `Invalid ${name}`,
  );
  return value as string[];
}

export function id(value: unknown, label = "task/check ID"): string {
  need(typeof value === "string" && ID.test(value), `Invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

// A safe repo-relative path with `/` separators: no empty, `.`, `..` or `.git` segments.
export function relative(value: unknown): string {
  text(value, "relative path");
  const rel = value as string;
  need(
    !rel.startsWith("/") &&
      !/^[a-zA-Z]:/.test(rel) &&
      !rel.includes("\\") &&
      !rel.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git"),
    `Unsafe relative path: ${JSON.stringify(rel)}`,
  );
  return rel;
}

// Whether `file` is one of the ownership entries or inside one of their directories.
export function owns(ownership: readonly string[], file: string, caseInsensitive = false): boolean {
  const f = caseInsensitive ? file.toLowerCase() : file;
  return ownership.some((entry) => {
    const p = caseInsensitive ? entry.toLowerCase() : entry;
    return f === p || f.startsWith(`${p}/`);
  });
}

export function validateChecks(checks: unknown, label = "checks"): Check[] {
  need(Array.isArray(checks), `${label} must be an array`);
  const names = new Set<string>();
  for (const c of checks) {
    checkedKeys(c, ["id", "argv", "timeoutMs"], "check");
    id(c.id, "check ID");
    need(!names.has(c.id as string), `Duplicate check ID: ${c.id}`);
    names.add(c.id as string);
    strings(c.argv, "check argv");
    need((c.argv as string[]).length > 0 && (c.argv as string[])[0], "Empty check command");
    need(
      c.timeoutMs === undefined ||
        (Number.isInteger(c.timeoutMs) &&
          (c.timeoutMs as number) > 0 &&
          (c.timeoutMs as number) <= 1_200_000),
      "Invalid check timeout",
    );
  }
  return checks as Check[];
}

export function validateModel(model: unknown): ModelRef {
  checkedKeys(model, ["provider", "id", "thinking"], "model");
  text(model.provider, "provider", 100);
  text(model.id, "model ID", 300);
  need(
    (THINKING_LEVELS as readonly unknown[]).includes(model.thinking),
    "Explicit supported thinking level required",
  );
  return model as unknown as ModelRef;
}

const TASK_FIELDS = [
  "id",
  "role",
  "task",
  "acceptance",
  "instructions",
  "context",
  "ownership",
  "after",
  "reviewOf",
  "reviewBase",
  "reviewPr",
  "checks",
  "evidenceChecks",
  "noChecksReason",
  "model",
  "backend",
] as const;

export function validateTask(input: unknown): Task {
  checkedKeys(input, TASK_FIELDS, "task");
  const task = input as unknown as TaskSpec;
  id(task.id, "task ID");
  const where = `Task ${task.id}`;
  need(
    (ROLES as readonly unknown[]).includes(task.role),
    `${where}: Unknown persona (role) ${JSON.stringify(task.role)}`,
  );
  text(task.task, `${where}: task`);
  strings(task.acceptance, `${where}: acceptance`);
  need(task.acceptance.length > 0, `${where}: acceptance criteria required`);
  if (task.model !== undefined) validateModel(task.model);
  if (task.backend !== undefined)
    need(
      (BACKENDS as readonly unknown[]).includes(task.backend),
      `${where}: backend must be one of ${BACKENDS.join(", ")}`,
    );
  strings(task.instructions ?? [], `${where}: instructions`);
  strings(task.context ?? [], `${where}: context`);
  strings(task.after ?? [], `${where}: after`).forEach((d) => id(d, `${where}: dependency ID`));
  strings(task.ownership ?? [], `${where}: ownership`).forEach(relative);
  validateChecks(task.checks ?? [], `${where}: checks`);
  validateChecks(task.evidenceChecks ?? [], `${where}: evidenceChecks`);
  validateChecks([...(task.checks ?? []), ...(task.evidenceChecks ?? [])], `${where}: checks`);
  if (task.role === "builder") {
    need((task.ownership?.length ?? 0) > 0, `${where}: builder ownership required`);
    if (!task.checks?.length) text(task.noChecksReason, `${where}: noChecksReason`);
  } else
    for (const field of ["ownership", "checks"] as const)
      need(
        !task[field]?.length,
        `${where}: ${field} is for builders only; remove it from this ${task.role} task`,
      );
  const targets = (["reviewOf", "reviewBase", "reviewPr"] as const).filter(
    (key) => task[key] !== undefined,
  );
  if (task.role === "reviewer")
    need(
      targets.length === 1,
      `${where}: a reviewer needs exactly one of reviewOf, reviewBase, or reviewPr`,
    );
  else need(targets.length === 0, `${where}: only reviewers use ${targets[0]}`);
  if (task.reviewOf !== undefined) id(task.reviewOf, `${where}: reviewOf`);
  if (task.reviewBase !== undefined)
    need(
      typeof task.reviewBase === "string" &&
        /^[^\s-][^\s]{0,199}$/.test(task.reviewBase) &&
        !task.reviewBase.includes("\0"),
      `${where}: reviewBase must be a Git revision such as HEAD or main`,
    );
  if (task.reviewPr !== undefined)
    need(
      Number.isSafeInteger(task.reviewPr) && task.reviewPr > 0,
      `${where}: reviewPr must be a pull request number`,
    );
  return {
    ...task,
    after: task.after ?? [],
    ownership: task.ownership ?? [],
    instructions: task.instructions ?? [],
    context: task.context ?? [],
    checks: task.checks ?? [],
    evidenceChecks: task.evidenceChecks ?? [],
  };
}

// All tasks a task depends on, directly or transitively.
export function ancestors(
  byId: ReadonlyMap<string, Task>,
  task: Task,
  seen = new Set<string>(),
): Set<string> {
  for (const name of task.after) {
    if (seen.has(name)) continue;
    seen.add(name);
    const dep = byId.get(name);
    if (dep) ancestors(byId, dep, seen);
  }
  return seen;
}

export interface GraphRules {
  // Builders need an approval recorded by the caller (0.7.0 consent semantics).
  allowWrites?: boolean;
  // Tasks already in the run when adding more.
  existing?: readonly Task[];
}

// Validates a whole graph before any agent starts. Returns tasks in input order.
export function validateGraph(inputs: unknown, rules: GraphRules = {}): Task[] {
  need(Array.isArray(inputs) && inputs.length > 0, "tasks must be a nonempty array");
  const tasks = (inputs as unknown[]).map(validateTask);
  const all = [...(rules.existing ?? []), ...tasks];
  const byId = new Map<string, Task>();
  for (const task of all) {
    need(!byId.has(task.id), `Task ${task.id}: duplicate task ID`);
    byId.set(task.id, task);
  }
  for (const task of all)
    for (const dep of task.after) {
      need(dep !== task.id, `Task ${task.id}: after lists itself`);
      need(byId.has(dep), `Task ${task.id}: after references unknown task ${dep}`);
    }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (task: Task, path: string[]) => {
    need(
      !visiting.has(task.id),
      `Task ${task.id}: cyclic dependencies (${[...path, task.id].join(" -> ")})`,
    );
    if (done.has(task.id)) return;
    visiting.add(task.id);
    for (const dep of task.after) visit(byId.get(dep)!, [...path, task.id]);
    visiting.delete(task.id);
    done.add(task.id);
  };
  for (const task of all) visit(task, []);
  for (const task of tasks) {
    if (task.role === "builder")
      need(
        rules.allowWrites,
        `Task ${task.id}: builders need an approval that authorizes local writes`,
      );
    if (task.reviewOf !== undefined) {
      const target = byId.get(task.reviewOf);
      need(target, `Task ${task.id}: reviewOf references unknown task ${task.reviewOf}`);
      need(target.role === "builder", `Task ${task.id}: reviewOf must name a builder task`);
      need(
        task.after.includes(target.id),
        `Task ${task.id}: list the reviewOf target ${target.id} in after`,
      );
    } else if (task.role === "reviewer")
      need(
        ![...ancestors(byId, task)].some((name) => byId.get(name)?.role === "builder"),
        `Task ${task.id}: to review a builder's change, use reviewOf instead of reviewBase or reviewPr`,
      );
  }
  for (const task of all)
    for (const other of all) {
      if (task === other || task.role !== "builder" || other.role !== "builder") continue;
      if (!tasks.includes(task) && !tasks.includes(other)) continue;
      const overlaps = task.ownership.some(
        (p) => owns(other.ownership, p) || other.ownership.some((q) => owns([p], q)),
      );
      need(
        !overlaps || ancestors(byId, task).has(other.id) || ancestors(byId, other).has(task.id),
        `Task ${task.id}: ownership overlaps independent builder ${other.id}`,
      );
    }
  return tasks;
}

export function validateLimits(input: unknown = {}): Limits {
  const value = input ?? {};
  checkedKeys(value, [...Object.keys(LIMITS), "costUsd"], "limits");
  const { costUsd, ...counts } = { ...LIMITS, ...value } as Limits;
  for (const [key, v] of Object.entries(counts))
    need(
      Number.isSafeInteger(v) &&
        (v as number) > 0 &&
        (v as number) <= LIMIT_MAX[key as keyof typeof LIMIT_MAX],
      `Invalid limit ${key}`,
    );
  need(
    costUsd === undefined ||
      (typeof costUsd === "number" &&
        Number.isFinite(costUsd) &&
        costUsd > 0 &&
        costUsd <= COST_MAX),
    `Invalid limit costUsd; use a dollar amount up to ${COST_MAX}`,
  );
  return costUsd === undefined ? counts : { ...counts, costUsd };
}
