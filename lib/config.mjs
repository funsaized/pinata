import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ROLES,
  LIMITS,
  LIMIT_MAX,
  COST_MAX,
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
  digest,
  atomic,
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
      "includeUncommitted",
      "workspaceReuse",
    ],
    "config",
  );
  const { costUsd, ...counts } = { ...LIMITS, ...input.limits };
  checkedKeys(counts, Object.keys(LIMITS), "limits");
  for (const [key, value] of Object.entries(counts))
    need(
      Number.isSafeInteger(value) && value > 0 && value <= LIMIT_MAX[key],
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
  const limits = costUsd === undefined ? counts : { ...counts, costUsd };
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
  need(
    [true, false, "copy-on-write"].includes(input.workspaceReuse ?? true),
    "workspaceReuse must be true, false, or copy-on-write",
  );
  need(
    typeof (input.includeUncommitted ?? true) === "boolean",
    "includeUncommitted must be a boolean",
  );
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
export function preferredModel(cfg, role, override) {
  const inherited =
    process.env.PI_PROVIDER && process.env.PI_MODEL
      ? {
          provider: process.env.PI_PROVIDER,
          id: process.env.PI_MODEL,
          thinking: process.env.PI_REASONING_LEVEL ?? "medium",
        }
      : null;
  return override ?? cfg.models[role] ?? cfg.models.default ?? inherited;
}

export function modelOrigin(run, task, fallback = false) {
  if (!fallback && task.model) return "task";
  const key = fallback
    ? `fallbacks.${task.role}`
    : `models.${run.config.models[task.role] ? task.role : "default"}`;
  return run.configSources?.origins[key] ?? (fallback ? "job" : "session");
}

// Readiness metadata is shared between short-lived CLI/coordinator processes.
// Persist only approved model IDs and successful probes, never auth output or
// credentials. File/environment changes invalidate it immediately; TTL bounds
// changes made at a provider without touching local configuration.
const modelCaches = new Map();
const READINESS_TTL = 300_000;
export async function modelCache(run) {
  const cfg = run.config;
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const files = [
    cfg.pi,
    path.join(run.cwd, ".pi/settings.json"),
    ...["auth.json", "models.json", "settings.json"].map((f) => path.join(agent, f)),
  ];
  const stamps = await Promise.all(
    files.map(async (file) => {
      const s = await fs.stat(file).catch(() => null);
      return s ? [file, s.ino, s.size, s.mtimeMs, s.ctimeMs] : [file, null];
    }),
  );
  const key = digest({ cwd: run.cwd, stamps, env: environment(cfg) });
  let cache = modelCaches.get(run.dir);
  if (!cache || cache.key !== key || Date.now() >= cache.expiresAt) {
    cache = {
      key,
      expiresAt: Date.now() + READINESS_TTL,
      selections: new Map(),
      auth: new Map(),
      ready: { auth: [], selections: [] },
      file: path.join(run.dir, "readiness.json"),
    };
    if (modelCaches.size >= 64) modelCaches.delete(modelCaches.keys().next().value);
    modelCaches.set(run.dir, cache);
    cache.hydrated = (async () => {
      const saved = await readJson(cache.file).catch(() => null);
      if (
        saved?.key !== key ||
        !Number.isSafeInteger(saved.expiresAt) ||
        saved.expiresAt <= Date.now() ||
        saved.expiresAt > cache.expiresAt
      )
        return;
      if (
        !Array.isArray(saved.catalog) ||
        !saved.catalog.every(
          (m) => m && typeof m.provider === "string" && typeof m.id === "string",
        ) ||
        !Array.isArray(saved.auth) ||
        !saved.auth.every((a) => typeof a === "string") ||
        !Array.isArray(saved.selections) ||
        !saved.selections.every((a) => typeof a === "string")
      )
        return;
      cache.expiresAt = saved.expiresAt;
      cache.ready = { catalog: saved.catalog, auth: saved.auth, selections: saved.selections };
      cache.catalog = Promise.resolve(saved.catalog);
      for (const id of saved.auth) cache.auth.set(id, Promise.resolve(true));
      for (const id of saved.selections) cache.selections.set(id, Promise.resolve(true));
    })();
  }
  await cache.hydrated;
  return cache;
}

async function persistReadiness(cache) {
  if (!cache?.ready.catalog) return;
  cache.write = (cache.write ?? Promise.resolve())
    .catch(() => {})
    .then(() => atomic(cache.file, { key: cache.key, expiresAt: cache.expiresAt, ...cache.ready }));
  await cache.write.catch(() => {}); // Cache storage failure is never a readiness failure.
}

async function cachedProbe(cache, kind, key, probe) {
  if (!cache) return probe();
  if (!cache[kind].has(key)) {
    const pending = probe()
      .then(async (ok) => {
        if (ok) {
          cache.ready[kind].push(key);
          await persistReadiness(cache);
        } else cache[kind].delete(key);
        return ok;
      })
      .catch((e) => {
        cache[kind].delete(key);
        throw e;
      });
    cache[kind].set(key, pending);
  }
  return cache[kind].get(key);
}

export async function selectModel(cfg, role, cwd, override, cache) {
  const preferred = preferredModel(cfg, role, override);
  need(
    preferred,
    "No model configured; specify config.models.default or invoke through the coordinating Pi bash tool",
  );
  const env = environment(cfg);
  const list = async () => {
    const data = await rpcProbe(cfg.pi, cwd, env, [{ id: "models", type: "get_available_models" }]);
    const available = data.get("models")?.models;
    need(Array.isArray(available), "Invalid Pi model metadata");
    return available.map(({ provider, id }) => ({ provider, id }));
  };
  if (cache && !cache.catalog)
    cache.catalog = list()
      .then(async (models) => {
        cache.ready.catalog = models;
        await persistReadiness(cache);
        return models;
      })
      .catch((e) => {
        delete cache.catalog;
        throw e;
      });
  const available = await (cache ? cache.catalog : list());
  const skipped = [];
  for (const model of [preferred, ...(cfg.fallbacks[role] ?? [])]) {
    validateModel(model);
    if (!available.some((m) => m.provider === model.provider && m.id === model.id)) {
      skipped.push(`${model.provider}/${model.id}: unavailable`);
      continue;
    }
    const authKey = `${model.provider}/${model.id}`,
      selectionKey = digest(model);
    const reused =
      cache?.ready.auth.includes(authKey) && cache?.ready.selections.includes(selectionKey);
    const [auth, selected] = await Promise.all([
      cachedProbe(cache, "auth", authKey, async () => {
        const r = await command(
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
        return r.code === 0;
      }),
      cachedProbe(cache, "selections", selectionKey, async () => {
        const data = await rpcProbe(
          cfg.pi,
          cwd,
          env,
          [{ id: "state", type: "get_state" }],
          ["--provider", model.provider, "--model", model.id, "--thinking", model.thinking],
        );
        const selected = data.get("state");
        return (
          selected?.model?.provider === model.provider &&
          selected?.model?.id === model.id &&
          selected?.thinkingLevel === model.thinking
        );
      }),
    ]);
    if (!auth || !selected) {
      skipped.push(
        `${model.provider}/${model.id}: ${!auth ? "authentication not ready" : "model/thinking selection changed"}`,
      );
      continue;
    }
    return { model, skipped, cached: Boolean(reused) };
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
