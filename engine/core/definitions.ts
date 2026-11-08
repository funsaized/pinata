// Plain execution settings. Discovery and Markdown parsing belong to the Pi adapter.
import { createHash } from "node:crypto";
import type { ModelRef, TaskSpec, Task } from "./types.ts";
import { ROLE_TOOLS } from "./types.ts";
import { checkedKeys, id, need, strings, text, validateModel } from "./validate.ts";

export const PRESETS = ["scout", "builder", "reviewer"] as const;
export type AgentWorkspace = "shared" | "worktree";
export interface AgentDefinition {
  schemaVersion: 2;
  access: "read" | "write";
  name: string;
  description: string;
  workspace: AgentWorkspace;
  tools: string[];
  prompt: string;
  output: { require: Array<"brief" | "sources"> };
  model?: ModelRef;
  fallbacks?: ModelRef[];
  source: string;
  digest: string;
}
export type Definitions = Record<string, AgentDefinition>;

export function definitionDigest(value: Omit<AgentDefinition, "digest">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateDefinition(input: unknown, source: string): AgentDefinition {
  checkedKeys(
    input,
    [
      "schemaVersion",
      "name",
      "description",
      "workspace",
      "access",
      "tools",
      "prompt",
      "output",
      "model",
      "fallbacks",
    ],
    "agent definition",
  );
  need(
    input.schemaVersion === 2,
    "Legacy agent definition: run pinata migrate (schemaVersion 2 separates access from workspace)",
  );
  need(input.access === "read" || input.access === "write", "Agent access must be read or write");
  const name = id(input.name, "agent name");
  const workspace = input.workspace as AgentWorkspace;
  need(["shared", "worktree"].includes(workspace), `Agent ${name}: invalid workspace`);
  const tools = strings(input.tools, "agent tools");
  need(
    tools.length <= 64 && new Set(tools).size === tools.length,
    `Agent ${name}: invalid tool list`,
  );
  for (const tool of tools) {
    need(
      /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(tool) &&
        !tool.startsWith("pinata_") &&
        !["codemode", "submit_result"].includes(tool),
      `Agent ${name}: invalid tool ${tool}`,
    );
    need(
      input.access === "write" || !["bash", "powershell", "write", "edit"].includes(tool),
      `Agent ${name}: ${tool} requires write access`,
    );
  }
  checkedKeys(input.output ?? {}, ["require"], "agent output");
  const required = strings(
    (input.output as { require?: unknown } | undefined)?.require ?? [],
    "required output",
  );
  need(
    required.every((field) => ["brief", "sources"].includes(field)) &&
      new Set(required).size === required.length,
    "Unsupported required output field",
  );
  const fallbacks = input.fallbacks as unknown[] | undefined;
  need(
    fallbacks === undefined || (Array.isArray(fallbacks) && fallbacks.length <= 5),
    "Invalid agent fallbacks",
  );
  const value: Omit<AgentDefinition, "digest"> = {
    schemaVersion: 2,
    access: input.access as "read" | "write",
    name,
    description: text(input.description, "agent description", 1000),
    workspace,
    tools: [...tools],
    prompt: text(input.prompt, "agent prompt"),
    output: { require: required as AgentDefinition["output"]["require"] },
    ...(input.model !== undefined && { model: validateModel(input.model) }),
    ...(fallbacks && { fallbacks: fallbacks.map(validateModel) }),
    source,
  };
  return { ...value, digest: definitionDigest(value) };
}

export function validateSnapshots(definitions: Definitions = {}): Definitions {
  for (const [digest, definition] of Object.entries(definitions)) {
    const { digest: saved, source, ...input } = definition;
    const checked = validateDefinition(input, source);
    need(
      saved === digest && checked.digest === digest,
      `Agent definition snapshot ${digest} changed`,
    );
  }
  return definitions;
}

export function agentName(task: Pick<TaskSpec, "agent" | "role">): string {
  return task.agent ?? task.role ?? "";
}
export function writes(task: { definition?: AgentDefinition; role?: string }): boolean {
  return task.definition ? task.definition.access === "write" : task.role === "builder";
}
export function reviews(task: { definition?: AgentDefinition; role?: string }): boolean {
  return task.definition ? task.definition.name === "reviewer" : task.role === "reviewer";
}
export function taskTools(task: { definition?: AgentDefinition; role?: string }): string[] {
  return task.definition?.tools ?? ROLE_TOOLS[task.role as keyof typeof ROLE_TOOLS] ?? [];
}

// Persist a definition once per run. Task records only carry its content-addressed reference.
export function taskSpec(task: Task): TaskSpec {
  const { definition, ...spec } = task;
  return { ...spec, ...(definition && { definition: definition.digest }) };
}
export function taskDefinitions(tasks: readonly Task[]): Definitions {
  return Object.fromEntries(
    tasks.flatMap((t) => (t.definition ? [[t.definition.digest, t.definition]] : [])),
  );
}
