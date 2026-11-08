import { agentName, writes, validateSnapshots, type Definitions } from "./definitions.ts";
// Task and graph validation. Errors name the task and field.
import {
  BACKENDS,
  ROLES,
  THINKING_LEVELS,
  type Check,
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
  "agent",
  "definition",
  "task",
  "acceptance",
  "instructions",
  "context",
  "after",
  "inputs",
  "workspace",
  "reviewOf",
  "reviewBase",
  "reviewPr",
  "model",
  "backend",
];
export const REMOVED_TASK_FIELDS = ["ownership", "checks", "evidenceChecks", "noChecksReason"];
export function migrationError(value: unknown, fields: readonly string[], label: string): void {
  if (!value || typeof value !== "object") return;
  const found = fields.filter((field) => Object.hasOwn(value, field));
  need(
    !found.length,
    `${label}: retired fields ${found.join(", ")}; run pinata migrate on this input (see docs/reference/migration.md)`,
  );
}
export function workspaceMode(value: unknown = "shared"): import("./types.ts").WorkspaceMode {
  need(value === "shared" || value === "worktree", "workspace must be shared or worktree");
  return value;
}
export function assignmentRef(value: unknown): import("./types.ts").AssignmentRef {
  checkedKeys(value, ["worker", "assignment"], "assignment reference");
  id(value.worker, "dependency worker");
  need(
    Number.isSafeInteger(value.assignment) && Number(value.assignment) > 0,
    "Invalid assignment ID",
  );
  return value as unknown as import("./types.ts").AssignmentRef;
}
export function validateTask(input: unknown, definitions: Definitions = {}): Task {
  migrationError(input, REMOVED_TASK_FIELDS, "task");
  checkedKeys(input, TASK_FIELDS, "task");
  const spec = input as unknown as TaskSpec;
  id(spec.id, "worker ID");
  const name = agentName(spec);
  const definition = spec.definition ? definitions[spec.definition] : undefined;
  need(
    !spec.definition || definition?.name === name,
    `Missing or mismatched agent definition: ${name}`,
  );
  need(definition || (ROLES as readonly string[]).includes(name), `Unknown agent ${name}`);
  text(spec.task, "assignment", Infinity);
  if (spec.model) validateModel(spec.model);
  if (spec.backend) need((BACKENDS as readonly string[]).includes(spec.backend), "Invalid backend");
  if (spec.workspace !== undefined) workspaceMode(spec.workspace);
  need(spec.after === undefined || Array.isArray(spec.after), "after must be an array");
  for (const dep of spec.after ?? [])
    if (typeof dep === "string") id(dep, "dependency worker");
    else assignmentRef(dep);
  need(spec.inputs === undefined || Array.isArray(spec.inputs), "inputs must be an array");
  for (const ref of spec.inputs ?? []) assignmentRef(ref);
  if (spec.reviewOf) id(spec.reviewOf);
  return {
    ...spec,
    role: name,
    definition,
    after: spec.after ?? [],
    acceptance: strings(spec.acceptance ?? [], "acceptance"),
    instructions: strings(spec.instructions ?? [], "instructions"),
    context: strings(spec.context ?? [], "context"),
  };
}
export function ancestors(
  byId: ReadonlyMap<string, Task>,
  task: Task,
  seen = new Set<string>(),
): Set<string> {
  for (const ref of task.after) {
    const name = typeof ref === "string" ? ref : ref.worker;
    if (seen.has(name)) continue;
    seen.add(name);
    const dep = byId.get(name);
    if (dep) ancestors(byId, dep, seen);
  }
  return seen;
}
export interface GraphRules {
  allowWrites?: boolean;
  definitions?: Definitions;
  existing?: readonly Task[];
}
export function validateGraph(inputs: unknown, rules: GraphRules = {}): Task[] {
  need(Array.isArray(inputs) && inputs.length > 0, "tasks must be a nonempty array");
  const tasks = inputs.map((input) => validateTask(input, validateSnapshots(rules.definitions)));
  const existing = rules.existing ?? [];
  const names = new Set(existing.map((task) => task.id));
  for (const task of tasks) {
    need(!names.has(task.id), `Duplicate worker ${task.id}`);
    names.add(task.id);
    need(
      !writes(task) || rules.allowWrites,
      `Worker ${task.id} needs authorization for local writes`,
    );
  }
  for (const task of tasks)
    for (const ref of [...task.after, ...(task.inputs ?? [])]) {
      const name = typeof ref === "string" ? ref : ref.worker;
      need(names.has(name), `Worker ${task.id}: unknown dependency ${name}`);
    }
  const added = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    need(!visiting.has(name), `Cyclic assignment dependency at ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const ref of added.get(name)?.after ?? []) {
      const worker = typeof ref === "string" ? ref : ref.worker;
      if (added.has(worker)) visit(worker);
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const task of tasks) visit(task.id);
  // Assignment graph validates cycles once references have been frozen.
  return tasks;
}
