import { configSchema, type Config } from "../contracts/config.ts";
import { definitionSchema, type AgentDefinition } from "../contracts/definition.ts";
import { jobSchema, type Job, type WorkerRequest } from "../contracts/commands.ts";
import { DomainError } from "../contracts/common.ts";
import {
  legacyConfigSchema,
  legacyDefinitionSchema,
  legacyJobSchema,
  type LegacyTask,
} from "./codecs.ts";

export type Conversion<T> = { value: T; notices: string[]; coordinatorInstructions: string[] };
const retired = [
  "limits",
  "reviewPolicy",
  "deadlineAt",
  "workspaceReuse",
  "pi",
  "herdr",
  "session",
] as const;

export function convertConfig(input: unknown): Conversion<Config> {
  if (input && typeof input === "object" && "schemaVersion" in input && input.schemaVersion === 4)
    return { value: configSchema.parse(input), notices: [], coordinatorInstructions: [] };
  const legacy = legacyConfigSchema.parse(input);
  const value: Record<string, unknown> = { ...legacy, schemaVersion: 4 };
  const notices: string[] = [];
  for (const field of retired)
    if (Object.hasOwn(value, field)) {
      delete value[field];
      notices.push(`config.${field} removed; it does not authorize or limit new execution.`);
    }
  if (!legacy.workspace)
    notices.push("Workspace defaults to shared; write capability still requires a separate grant.");
  return { value: configSchema.parse(value), notices, coordinatorInstructions: [] };
}

export function convertDefinition(input: unknown): Conversion<AgentDefinition> {
  const legacy = legacyDefinitionSchema.parse(input);
  const access =
    legacy.schemaVersion === 2
      ? legacy.access
      : (legacy.access ?? (legacy.workspace === "worktree" ? "write" : "read"));
  if (!access)
    throw new DomainError("invalid_input", "Schema-2 definitions require explicit access");
  if (
    access === "read" &&
    legacy.tools.some((tool) => ["bash", "powershell", "write", "edit"].includes(tool))
  )
    throw new DomainError(
      "capability_denied",
      "Legacy read-only definition includes a write-capable tool",
    );
  if (new Set(legacy.tools).size !== legacy.tools.length)
    throw new DomainError("invalid_input", "Legacy definition repeats tools");
  const coordinatorInstructions = legacy.output?.require.length
    ? [`Legacy output preference (not engine-enforced): ${legacy.output.require.join(", ")}.`]
    : [];
  const value = definitionSchema.parse({
    schemaVersion: 3,
    name: legacy.name,
    instructions: [legacy.prompt, ...coordinatorInstructions].filter(Boolean).join("\n\n"),
    handoffDescription: legacy.description,
    ...(legacy.model
      ? {
          model: `${legacy.model.provider}/${legacy.model.id}`,
          modelSettings: { reasoning: { effort: legacy.model.thinking } },
        }
      : {}),
    tools: legacy.tools,
    handoffs: [],
    pinata: {
      access,
      workspace: legacy.workspace === "worktree" ? "worktree" : "shared",
      fallbacks: legacy.fallbacks ?? [],
      skills: [],
      inheritContext: "none",
      memory: { scope: "none", access: "read" },
      delegation: { maxDepth: 0 },
      checkpoint: "none",
    },
  });
  return {
    value,
    coordinatorInstructions,
    notices: [
      "Converted definition preserves tools, access, workspace and model settings.",
      "New context inheritance, skills, memory, delegation and completion checkpoints remain disabled.",
      ...(coordinatorInstructions.length
        ? ["Mandatory output requirements became unenforced instruction text."]
        : []),
    ],
  };
}

export function convertTask(
  task: LegacyTask,
  options: { run?: string; instructions?: string[]; workspace?: "shared" | "worktree" } = {},
): WorkerRequest {
  const agent = task.agent ?? task.role;
  if (!agent)
    throw new DomainError(
      "invalid_input",
      `Legacy task ${task.id} has no agent definition identity`,
    );
  const exact = (reference: { worker: string; assignment: number }) => {
    if (!options.run)
      throw new DomainError(
        "invalid_input",
        "Converting exact legacy references requires the new run identity",
      );
    return { run: options.run, ...reference };
  };
  const context = [
    ...(options.instructions ?? []),
    ...(task.instructions ?? []),
    ...(task.context ?? []),
  ];
  for (const item of task.acceptance ?? [])
    context.push(`Coordinator acceptance intent (not engine-enforced): ${item}`);
  for (const item of [...(task.checks ?? []), ...(task.evidenceChecks ?? [])])
    context.push(
      `Requested check for coordinator consideration (not engine-enforced): ${JSON.stringify(item)}`,
    );
  if (task.ownership?.length)
    context.push(
      `Suggested file responsibility: ${task.ownership.join(", ")}. Preserve unrelated work; no ownership gate is created.`,
    );
  if (task.noChecksReason) context.push(`Historical check rationale: ${task.noChecksReason}`);
  if (task.reviewOf)
    context.push(
      `Review subject: ${task.reviewOf}; review does not gate execution or application.`,
    );
  if (task.reviewBase) context.push(`Review comparison base: ${task.reviewBase}`);
  if (task.reviewPr) context.push(`Review pull request: ${task.reviewPr}`);
  return {
    id: task.id,
    agent,
    task: task.task,
    after: (task.after ?? []).map((ref) => (typeof ref === "string" ? ref : exact(ref))),
    inputs: (task.inputs ?? []).map(exact),
    context,
    workspace:
      task.workspace ?? options.workspace ?? (task.role === "builder" ? "worktree" : undefined),
    ...(task.model ? { model: task.model } : {}),
    ...(task.backend ? { backend: task.backend } : {}),
    inheritContext: "none",
    memory: { scope: "none", access: "read" },
    delegation: { maxDepth: 0 },
    lifetime: "attached",
  };
}

export function convertJob(input: unknown, options: { run?: string } = {}): Conversion<Job> {
  const legacy = legacyJobSchema.parse(input);
  const converted = convertConfig(legacy.config ?? {});
  const coordinatorInstructions = [...(legacy.instructions ?? [])];
  if (legacy.integratedChecks?.length)
    coordinatorInstructions.push(
      `Requested destination checks (not engine-enforced): ${JSON.stringify(legacy.integratedChecks)}`,
    );
  if (legacy.noIntegratedChecksReason)
    coordinatorInstructions.push(
      `Historical destination check rationale: ${legacy.noIntegratedChecksReason}`,
    );
  const notices = [
    ...converted.notices,
    "Conversion creates no execution, application, write grant or approval; authorize the new job explicitly.",
  ];
  for (const field of [
    "limits",
    "deadlineAt",
    "reviewPolicy",
    "integration",
    "allowWrites",
    "approval",
    "cwd",
  ] as const)
    if (Object.hasOwn(legacy, field))
      notices.push(
        `job.${field} retained as conversion provenance only; no new authority or retired policy is inferred.`,
      );
  for (const task of legacy.tasks)
    for (const field of [
      "limits",
      "deadlineAt",
      "ownership",
      "checks",
      "evidenceChecks",
      "noChecksReason",
    ] as const)
      if (Object.hasOwn(task, field))
        notices.push(
          `task ${task.id}.${field} removed from engine policy; useful intent remains instruction text.`,
        );
  return {
    value: jobSchema.parse({
      schemaVersion: 4,
      workers: legacy.tasks.map((task) =>
        convertTask(task, {
          run: options.run ?? legacy.run,
          instructions: coordinatorInstructions,
          workspace: legacy.workspace,
        }),
      ),
      config: converted.value,
    }),
    notices,
    coordinatorInstructions,
  };
}
