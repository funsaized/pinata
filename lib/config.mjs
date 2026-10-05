import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ROLES,
  LIMITS,
  LIMIT_MAX,
  need,
  text,
  strings,
  checkedKeys,
  command,
  environment,
  validateModel,
  rpcProbe,
  readJson,
  exists,
} from "./core.mjs";

export async function executable(name) {
  text(name, "executable");
  for (const file of path.isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? "").split(path.delimiter).map((p) => path.join(p, name))) {
    try {
      await fs.access(file, fs.constants.X_OK);
      return await fs.realpath(file);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`Missing executable: ${name}; propose installation before proceeding`);
}
export function config(input = {}) {
  checkedKeys(
    input,
    [
      "pi",
      "herdr",
      "models",
      "fallbacks",
      "passEnv",
      "webExtension",
      "session",
      "limits",
      "setup",
      "codemode",
    ],
    "config",
  );
  const limits = { ...LIMITS, ...input.limits };
  checkedKeys(limits, Object.keys(LIMITS), "limits");
  for (const [key, value] of Object.entries(limits))
    need(
      Number.isSafeInteger(value) && value > 0 && value <= LIMIT_MAX[key],
      `Invalid limit ${key}`,
    );
  strings(input.passEnv ?? [], "passEnv").forEach((key) =>
    need(
      /^[A-Z][A-Z0-9_]*$/.test(key) &&
        !key.startsWith("PINATA_") &&
        !key.startsWith("HERDR_") &&
        !key.startsWith("PI_") &&
        !["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(key),
      "Unsafe passEnv entry",
    ),
  );
  checkedKeys(input.models ?? {}, ["default", ...ROLES], "models");
  Object.values(input.models ?? {}).forEach(validateModel);
  checkedKeys(input.fallbacks ?? {}, ROLES, "fallbacks");
  for (const choices of Object.values(input.fallbacks ?? {})) {
    need(Array.isArray(choices) && choices.length <= 5, "Invalid fallback list");
    choices.forEach(validateModel);
  }
  if (input.setup !== undefined)
    need(
      input.setup === false || (typeof input.setup === "string" && input.setup.trim()),
      "setup must be a nonempty shell command or false",
    );
  need(typeof (input.codemode ?? true) === "boolean", "codemode must be a boolean");
  if (input.session !== undefined)
    need(/^[a-zA-Z0-9_-]+$/.test(input.session), "Invalid Herdr session name");
  return {
    ...input,
    limits,
    passEnv: input.passEnv ?? [],
    models: input.models ?? {},
    fallbacks: input.fallbacks ?? {},
  };
}
export async function selectModel(cfg, role, cwd, override) {
  const inherited =
    process.env.PI_PROVIDER && process.env.PI_MODEL
      ? {
          provider: process.env.PI_PROVIDER,
          id: process.env.PI_MODEL,
          thinking: process.env.PI_REASONING_LEVEL ?? "medium",
        }
      : null;
  const preferred = override ?? cfg.models[role] ?? cfg.models.default ?? inherited;
  need(
    preferred,
    "No model configured; specify config.models.default or invoke through the coordinating Pi bash tool",
  );
  const env = environment(cfg);
  const data = await rpcProbe(cfg.pi, cwd, env, [{ id: "models", type: "get_available_models" }]);
  const available = data.get("models")?.models;
  need(Array.isArray(available), "Invalid Pi model metadata");
  const skipped = [];
  for (const model of [preferred, ...(cfg.fallbacks[role] ?? [])]) {
    validateModel(model);
    if (!available.some((m) => m.provider === model.provider && m.id === model.id)) {
      skipped.push(`${model.provider}/${model.id}: unavailable`);
      continue;
    }
    const auth = await command(
      [
        cfg.pi,
        "auth",
        "check",
        "--provider",
        model.provider,
        "--model",
        model.id,
        "--json",
        "--no-refresh",
      ],
      { cwd, env },
    );
    if (auth.code !== 0) {
      skipped.push(`${model.provider}/${model.id}: authentication not ready`);
      continue;
    }
    const state = await rpcProbe(
      cfg.pi,
      cwd,
      env,
      [{ id: "state", type: "get_state" }],
      ["--provider", model.provider, "--model", model.id, "--thinking", model.thinking],
    );
    const selected = state.get("state");
    if (
      selected?.model?.provider !== model.provider ||
      selected?.model?.id !== model.id ||
      selected?.thinkingLevel !== model.thinking
    ) {
      skipped.push(`${model.provider}/${model.id}: model/thinking selection changed`);
      continue;
    }
    return { model, skipped };
  }
  throw new Error(`No approved model ready: ${skipped.join("; ")}`);
}

// Keys merged per entry across layers; every other key is replaced whole.
const MERGED = ["models", "fallbacks", "limits"];

export function configFiles(root) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return [
    ["global", path.join(agentDir, "pinata.json")],
    ...(root ? [["project", path.join(root, ".pi", "pinata.json")]] : []),
  ];
}

// Layers ~/.pi/agent/pinata.json, then <root>/.pi/pinata.json, then the job's own
// config, like Pi's settings. Returns the merged config, the files read, and which
// layer supplied each key (models, fallbacks, and limits per entry).
export async function layeredConfig(jobConfig = {}, root) {
  const layers = [];
  for (const [name, file] of configFiles(root)) {
    if (!(await exists(file))) continue;
    const real = await fs.realpath(file);
    let value;
    try {
      value = await readJson(real);
      config(value);
    } catch (e) {
      throw new Error(`${file}: ${e.message}`, { cause: e });
    }
    layers.push({ name, file, value });
  }
  layers.push({ name: "job", value: jobConfig });
  const merged = {},
    origins = {};
  for (const { name, value } of layers)
    for (const [key, v] of Object.entries(value)) {
      if (MERGED.includes(key)) {
        merged[key] = { ...merged[key], ...v };
        for (const entry of Object.keys(v)) origins[`${key}.${entry}`] = name;
      } else {
        merged[key] = v;
        origins[key] = name;
      }
    }
  return {
    config: merged,
    files: layers.filter((l) => l.file).map(({ name, file }) => ({ layer: name, file })),
    origins,
  };
}
