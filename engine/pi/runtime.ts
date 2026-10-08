// The shared child model runtime. Pi does not expose its model runtime to extensions, so one
// child ModelRuntime is created per parent session from the same auth.json and models.json,
// and the providers that extensions registered in the parent are replayed into it. Model
// selection uses ctx.modelRegistry; no probe processes.
import { join } from "node:path";
import { ModelRuntime, getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelRef, ThinkingLevel } from "../core/types.ts";

// Copies extension-registered providers from the parent registry. Returns the provider ids.
export function replayProviders(registry: ModelRegistry, runtime: ModelRuntime): string[] {
  const ids: string[] = [];
  for (const id of registry.getRegisteredProviderIds()) {
    const native = registry.getRegisteredNativeProvider(id);
    if (native) runtime.registerNativeProvider(native);
    else {
      const config = registry.getRegisteredProviderConfig(id);
      if (!config) continue;
      runtime.registerProvider(id, config);
    }
    ids.push(id);
  }
  return ids;
}

export async function createChildRuntime(
  registry: ModelRegistry,
  agentDir = getAgentDir(),
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  replayProviders(registry, runtime);
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

// One child runtime per parent session. Later calls are free unless the parent registered
// more providers since, which are replayed then.
export class RuntimeCache {
  private pending: Promise<ModelRuntime> | undefined;
  private replayed = new Set<string>();
  private readonly agentDir: string | undefined;

  constructor(agentDir?: string) {
    this.agentDir = agentDir;
  }

  async get(registry: ModelRegistry): Promise<ModelRuntime> {
    if (!this.pending) {
      this.pending = createChildRuntime(registry, this.agentDir);
      this.pending.catch(() => (this.pending = undefined));
      const runtime = await this.pending;
      this.replayed = new Set(registry.getRegisteredProviderIds());
      return runtime;
    }
    const runtime = await this.pending;
    const ids = registry.getRegisteredProviderIds();
    if (ids.some((id) => !this.replayed.has(id))) {
      replayProviders(registry, runtime);
      this.replayed = new Set(ids);
      await runtime.refresh({ allowNetwork: false });
    }
    return runtime;
  }

  dispose(): void {
    this.pending = undefined;
    this.replayed.clear();
  }
}

export interface ModelChoice {
  model: ModelRef;
  // Why this model: task, config role, config default, or the parent session.
  origin: "task" | "role" | "default" | "session" | "fallback";
  skipped: string[];
}

// Picks the first available model: the task's, then the configured role or default model,
// then the parent's, then the role's fallbacks. Availability: known to the registry with
// configured auth. No processes are started.
export function selectModel(
  registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">,
  candidates: Array<{ model: ModelRef | undefined; origin: ModelChoice["origin"] }>,
): ModelChoice {
  const skipped: string[] = [];
  for (const { model, origin } of candidates) {
    if (!model) continue;
    const found = registry.find(model.provider, model.id);
    if (!found) {
      skipped.push(`${model.provider}/${model.id}: unknown model`);
      continue;
    }
    // The parent session's current model is in use, so it is usable; other candidates need
    // configured authentication.
    if (origin !== "session" && !registry.hasConfiguredAuth(found)) {
      skipped.push(`${model.provider}/${model.id}: no configured authentication`);
      continue;
    }
    return { model, origin, skipped };
  }
  throw new Error(
    `No configured model is available${skipped.length ? `: ${skipped.join("; ")}` : ""}`,
  );
}

export function inherited(
  model: { provider: string; id: string } | undefined,
  thinking: ThinkingLevel | string | undefined,
): ModelRef | undefined {
  return model
    ? { provider: model.provider, id: model.id, thinking: (thinking ?? "medium") as ThinkingLevel }
    : undefined;
}
