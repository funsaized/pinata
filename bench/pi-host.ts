// A bench extension that runs a scenario on the engine inside the real `pi` binary (Bun), as
// the prototype did. The runner passes BENCH_SPEC (a JSON file) and sends `/pinata-bench`.
import { readFileSync, writeFileSync } from "node:fs";
import * as ai from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxStep, runEngineScenario } from "./targets/engine-core.ts";
import type { ModelRef } from "../engine/core/types.ts";
import type { Scenario } from "./lib.ts";

export interface PiHostSpec {
  scenario: Scenario;
  provider: "faux" | "loopback";
  model: ModelRef;
  agentDir: string;
  repo: string;
  runsDir: string;
  out: string;
  tokenDelayMs: number;
}

export default function (pi: ExtensionAPI) {
  const file = process.env.BENCH_SPEC;
  if (!file) return;
  const spec = JSON.parse(readFileSync(file, "utf8")) as PiHostSpec;
  const firstRequest: Record<string, number> = {};
  if (spec.provider === "faux") {
    const faux = ai.fauxProvider({
      provider: spec.model.provider,
      models: [{ id: spec.model.id, contextWindow: 200_000, maxTokens: 8192 }],
      ...(spec.tokenDelayMs > 0 && { tokensPerSecond: 1000 / spec.tokenDelayMs }),
    });
    const step = fauxStep(spec.scenario, firstRequest, ai);
    faux.setResponses(Array.from({ length: 100_000 }, () => step));
    pi.registerProvider(faux.provider);
  }
  pi.registerCommand("pinata-bench", {
    description: "Run one engine bench scenario in this Pi",
    handler: async (_args, ctx) => {
      try {
        const raw = await runEngineScenario(spec.scenario, {
          registry: ctx.modelRegistry,
          model: spec.model,
          agentDir: spec.agentDir,
          repo: spec.repo,
          runsDir: spec.runsDir,
        });
        writeFileSync(spec.out, JSON.stringify({ ...raw, firstRequest }));
      } catch (error) {
        writeFileSync(spec.out, JSON.stringify({ error: (error as Error).stack ?? String(error) }));
      }
      ctx.shutdown();
    },
  });
}
