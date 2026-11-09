import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  canonicalJson,
  DomainError,
  frozenWorkerSchema,
  type AgentDefinition,
  type FrozenWorker,
} from "../contracts/index.ts";
import {
  convertConfig,
  convertDefinition,
  convertJob,
  type Conversion,
} from "../migration/convert.ts";
import { importLegacyRun, type MigrationPlan } from "../migration/index.ts";
import type { Host } from "../host/index.ts";
import { processArtifacts } from "../backends/process-transport.ts";
import { WorkspaceLayer } from "../workspace/index.ts";
import { insideWorkspace } from "../workspace/paths.ts";
import { isMissing } from "../storage/io.ts";

export async function validateMigrationDestination(
  plan: MigrationPlan,
  path: string,
): Promise<void> {
  let parent = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      parent = await realpath(parent);
      break;
    } catch (error) {
      if (!isMissing(error) || dirname(parent) === parent) throw error;
      suffix.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
  const destination = join(parent, ...suffix);
  if (
    [plan.inspection.directory, ...plan.inspection.workspaces].some((source) =>
      insideWorkspace(source, destination),
    )
  )
    throw new DomainError(
      "conflict",
      "Migration outputs must remain outside retained legacy stores and workspaces",
    );
}

export function definitionMarkdown(definition: AgentDefinition): string {
  const { instructions, ...frontmatter } = definition;
  return `---\n${Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")}\n---\n\n${instructions}\n`;
}

export async function convertFile(options: {
  path: string;
  kind?: string;
  output?: string;
  run?: string;
}): Promise<Conversion<unknown>> {
  const bytes = await readFile(resolve(options.path), "utf8");
  let input: unknown;
  let kind = options.kind;
  if (extname(options.path).toLowerCase() === ".md") {
    const parsed = parseFrontmatter(bytes);
    input = { ...parsed.frontmatter, prompt: parsed.body };
    kind ??= "definition";
  } else input = JSON.parse(bytes);
  kind ??= input && typeof input === "object" && "tasks" in input ? "job" : "config";
  let converted: Conversion<unknown>;
  let output: string;
  switch (kind) {
    case "job":
      converted = convertJob(input, { run: options.run });
      output = `${canonicalJson(converted.value)}\n`;
      break;
    case "config":
      converted = convertConfig(input);
      output = `${canonicalJson(converted.value)}\n`;
      break;
    case "definition": {
      const definition = convertDefinition(input);
      converted = definition;
      output = definitionMarkdown(definition.value);
      break;
    }
    default:
      throw new DomainError("invalid_input", "Migration kind is job, config or definition", "kind");
  }
  if (options.output) await writeFile(resolve(options.output), output, { flag: "wx", mode: 0o600 });
  return converted;
}

export async function importPlannedRun(plan: MigrationPlan, host: Host, requestId: string) {
  const artifacts = processArtifacts(host.directory);
  const workspace = new WorkspaceLayer({
    root: host.workspace,
    storeDirectory: host.directory,
    worktreeRoot: host.config.worktreeRoot,
    includeUncommitted: host.config.includeUncommitted,
  });
  const workers: FrozenWorker[] = [];
  for (const [id, definition] of Object.entries(plan.manifest.definitions)) {
    const original = plan.inspection.assignments.find((entry) => entry.worker === id);
    if (!original) throw new DomainError("invalid_input", "Imported definition has no assignment");
    const model = definition.model
      ? {
          provider: definition.model.slice(0, definition.model.indexOf("/")),
          id: definition.model.slice(definition.model.indexOf("/") + 1),
          thinking: definition.modelSettings.reasoning?.effort ?? "off",
        }
      : original.task.model;
    const access = plan.inspection.run.allowWrites ? definition.pinata.access : "read";
    const grants = {
      access,
      tools: definition.tools,
      workspaces: [definition.pinata.workspace],
      inheritContext: false,
      memory: { scope: "none", access: "read" },
      delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
    };
    workers.push(
      frozenWorkerSchema.parse({
        id,
        agent: definition.name,
        definition: await artifacts.put(Buffer.from(canonicalJson(definition))),
        ...(model ? { model } : {}),
        fallbacks: definition.pinata.fallbacks,
        tools: definition.tools,
        access,
        workspace: definition.pinata.workspace,
        backend: original.task.backend ?? host.config.backend,
        lifetime: "attached",
        depth: 0,
        grants,
        workspacePlan: await workspace.freeze(
          { run: host.caller.run, worker: id, mode: definition.pinata.workspace },
          artifacts,
        ),
      }),
    );
  }
  return importLegacyRun(plan, {
    runtime: host.runtime,
    caller: host.caller,
    workers,
    artifacts,
    requestId,
  });
}
