// Pinata configuration, layered like 0.7.0: ~/.pi/agent/pinata.json, then
// <repo>/.pi/pinata.json, then the run's own config. models, fallbacks and limits merge per
// entry; other keys are replaced whole. Adds `mode` and `backend`.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BACKENDS,
  ROLES,
  type BackendKind,
  type Limits,
  type Mode,
  type ModelRef,
  type Role,
} from "../core/types.ts";
import { checkedKeys, need, strings, validateLimits, validateModel } from "../core/validate.ts";

export interface PinataConfig {
  models: Partial<Record<Role | "default", ModelRef>>;
  fallbacks: Partial<Record<Role, ModelRef[]>>;
  limits: Limits;
  passEnv: string[];
  webExtension?: string;
  setup?: string | false;
  codemode: boolean;
  includeUncommitted: boolean;
  mode: Mode;
  backend: BackendKind;
}

// Keys 0.7.0 used that the engine ignores, with the notice shown once.
export const RETIRED: Record<string, string> = {
  pi: "config.pi is ignored: agents run inside this Pi.",
  herdr: "config.herdr is ignored: the herdr-pi backend uses the herdr on PATH.",
  session: "config.session is ignored: Herdr panes open in the current Herdr session.",
  workspaceReuse:
    "config.workspaceReuse is ignored: readers use the live checkout and builders a git worktree.",
};

const KEYS = [
  "models",
  "fallbacks",
  "passEnv",
  "webExtension",
  "limits",
  "setup",
  "codemode",
  "includeUncommitted",
  "mode",
  "backend",
  ...Object.keys(RETIRED),
];
const MERGED = ["models", "fallbacks", "limits"];

export function validateConfig(input: unknown = {}): { config: PinataConfig; notices: string[] } {
  const value = input ?? {};
  checkedKeys(value, KEYS, "config");
  const v = value as Record<string, any>;
  const notices = Object.keys(RETIRED)
    .filter((k) => v[k] !== undefined)
    .map((k) => RETIRED[k]);
  checkedKeys(v.models ?? {}, ["default", ...ROLES], "models");
  for (const m of Object.values(v.models ?? {})) validateModel(m);
  checkedKeys(v.fallbacks ?? {}, ROLES, "fallbacks");
  for (const list of Object.values(v.fallbacks ?? {})) {
    need(Array.isArray(list) && list.length <= 5, "Invalid fallback list");
    (list as unknown[]).forEach(validateModel);
  }
  strings(v.passEnv ?? [], "passEnv").forEach((key) =>
    need(
      /^[A-Z][A-Z0-9_]*$/.test(key) &&
        !key.startsWith("PINATA_") &&
        !key.startsWith("HERDR_") &&
        !key.startsWith("PI_") &&
        !["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(key),
      "Unsafe passEnv entry",
    ),
  );
  if (v.setup !== undefined)
    need(
      v.setup === false || (typeof v.setup === "string" && v.setup.trim()),
      "setup must be a nonempty shell command or false",
    );
  need(typeof (v.codemode ?? true) === "boolean", "codemode must be a boolean");
  need(typeof (v.includeUncommitted ?? true) === "boolean", "includeUncommitted must be a boolean");
  need(
    v.mode === undefined || v.mode === "lean" || v.mode === "observe",
    'mode must be "lean" or "observe"',
  );
  need(
    v.backend === undefined || (BACKENDS as readonly string[]).includes(v.backend),
    `backend must be one of ${BACKENDS.join(", ")}`,
  );
  if (v.webExtension !== undefined)
    need(typeof v.webExtension === "string" && v.webExtension, "webExtension must be a path");
  return {
    config: {
      models: v.models ?? {},
      fallbacks: v.fallbacks ?? {},
      limits: validateLimits(v.limits ?? {}),
      passEnv: v.passEnv ?? [],
      ...(v.webExtension && { webExtension: v.webExtension }),
      ...(v.setup !== undefined && { setup: v.setup }),
      codemode: v.codemode ?? true,
      includeUncommitted: v.includeUncommitted ?? true,
      mode: v.mode ?? "lean",
      backend: v.backend ?? "in-process",
    },
    notices,
  };
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configFiles(root?: string): Array<[layer: string, file: string]> {
  return [
    ["global", join(agentDir(), "pinata.json")],
    ...(root ? [["project", join(root, ".pi", "pinata.json")] as [string, string]] : []),
  ];
}

export interface Layered {
  config: PinataConfig;
  files: Array<{ layer: string; file: string }>;
  origins: Record<string, string>;
  notices: string[];
}

export function layeredConfig(runConfig: unknown = {}, root?: string): Layered {
  const layers: Array<{ name: string; file?: string; value: Record<string, unknown> }> = [];
  for (const [name, file] of configFiles(root)) {
    if (!existsSync(file)) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(readFileSync(realpathSync(file), "utf8"));
      validateConfig(value);
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
    }
    layers.push({ name, file, value });
  }
  layers.push({ name: "run", value: (runConfig ?? {}) as Record<string, unknown> });
  const merged: Record<string, any> = {};
  const origins: Record<string, string> = {};
  for (const { name, value } of layers)
    for (const [key, v] of Object.entries(value)) {
      if (MERGED.includes(key)) {
        merged[key] = { ...merged[key], ...(v as object) };
        for (const entry of Object.keys(v as object)) origins[`${key}.${entry}`] = name;
      } else {
        merged[key] = v;
        origins[key] = name;
      }
    }
  const { config, notices } = validateConfig(merged);
  return {
    config,
    files: layers.filter((l) => l.file).map((l) => ({ layer: l.name, file: l.file! })),
    origins,
    notices,
  };
}

// Model candidates for a task, in 0.7.0's order: the first of the task's model, the role's,
// the default and the parent session's, then the role's fallbacks.
export function modelCandidates(
  config: PinataConfig,
  role: Role,
  taskModel: ModelRef | undefined,
  session: ModelRef | undefined,
): Array<{
  model: ModelRef | undefined;
  origin: "task" | "role" | "default" | "session" | "fallback";
}> {
  const preferred = [
    { model: taskModel, origin: "task" as const },
    { model: config.models[role], origin: "role" as const },
    { model: config.models.default, origin: "default" as const },
    { model: session, origin: "session" as const },
  ].find((c) => c.model);
  return [
    ...(preferred ? [preferred] : []),
    ...(config.fallbacks[role] ?? []).map((model) => ({ model, origin: "fallback" as const })),
  ];
}
