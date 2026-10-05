import * as fs from "node:fs/promises";
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
    ["pi", "herdr", "models", "fallbacks", "passEnv", "webExtension", "session", "limits"],
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
