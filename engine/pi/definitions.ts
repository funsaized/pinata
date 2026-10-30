import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  PRESETS,
  agentName,
  validateDefinition,
  type AgentDefinition,
  type Definitions,
} from "../core/definitions.ts";
import type { TaskSpec } from "../core/types.ts";
import { need } from "../core/validate.ts";
import { agentDir } from "./config.ts";

const PRESET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
const cache = new Map<string, { stamp: string; definition: AgentDefinition }>();

export function readDefinition(file: string): AgentDefinition {
  const source = realpathSync(file);
  const stat = statSync(source);
  need(
    stat.isFile() && stat.size <= 128 * 1024,
    `${file}: agent definition must be a file under 128 KiB`,
  );
  const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  const hit = cache.get(source);
  if (hit?.stamp === stamp) return structuredClone(hit.definition);
  try {
    const { frontmatter, body } = parseFrontmatter(readFileSync(source, "utf8"));
    const definition = validateDefinition({ ...frontmatter, prompt: body.trim() }, source);
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(source, { stamp, definition });
    return structuredClone(definition);
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
  }
}

export function discoverAgents(root?: string, personal = agentDir()): Map<string, AgentDefinition> {
  const agents = new Map<string, AgentDefinition>();
  const directories = [
    PRESET_DIR,
    join(personal, "pinata", "agents"),
    ...(root ? [join(root, ".pi", "pinata", "agents")] : []),
  ];
  for (const [scope, directory] of directories.entries()) {
    if (!existsSync(directory)) continue;
    const names = new Set<string>();
    for (const file of readdirSync(directory)
      .filter((f) => f.endsWith(".md"))
      .sort()) {
      const definition = readDefinition(join(directory, file));
      need(!names.has(definition.name), `${directory}: duplicate agent ${definition.name}`);
      need(
        scope === 0 || !(PRESETS as readonly string[]).includes(definition.name),
        `${definition.name} is a reserved preset; give your agent a new name`,
      );
      names.add(definition.name);
      agents.set(definition.name, definition);
    }
  }
  return agents;
}

export function resolveTasks(
  inputs: readonly TaskSpec[],
  agents: ReadonlyMap<string, AgentDefinition>,
): { tasks: TaskSpec[]; definitions: Definitions; notices: string[] } {
  const definitions: Definitions = {};
  const notices = new Set<string>();
  const tasks = inputs.map((task) => {
    need(
      task && typeof task === "object" && !task.definition,
      "Task definition snapshots are assigned by Pinata",
    );
    need(
      !(task.agent && task.role && task.agent !== task.role),
      "Use agent or role, not conflicting selectors",
    );
    const requested = agentName(task);
    const name = requested === "research" && !task.agent ? "researcher" : requested;
    const definition = agents.get(name);
    need(
      definition,
      ["planner", "research", "researcher"].includes(requested)
        ? `Agent ${requested} is an optional example. Copy examples/agents/${name}.md to .pi/pinata/agents/${name}.md, then use agent: ${name}.`
        : `Unknown agent ${JSON.stringify(name)}; use pinata_agents to list available definitions`,
    );
    if (task.role)
      notices.add(
        "task.role is deprecated; use task.agent. research is now the optional researcher example.",
      );
    definitions[definition.digest] = definition;
    return { ...task, role: name, agent: name, definition: definition.digest };
  });
  return { tasks, definitions, notices: [...notices] };
}
