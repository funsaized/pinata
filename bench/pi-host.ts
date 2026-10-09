// A bench extension that runs a scenario on the engine inside the real `pi` binary (Bun), as
// the prototype did. The runner passes BENCH_SPEC (a JSON file) and sends `/pinata-bench`.
import { readFileSync, writeFileSync } from "node:fs";
import * as ai from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PinataUI } from "../engine/pi/ui.ts";
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
  // Interactive TUI (E4.6): the run starts by itself, with the widget, footer and the first
  // agent's detail view open, and Pi exits when it settles.
  tui?: boolean;
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
  const bench = async (ctx: ExtensionContext) => {
    const ui = spec.tui ? new PinataUI(pi) : undefined;
    try {
      ui?.bind(ctx);
      const raw = await runEngineScenario(spec.scenario, {
        registry: ctx.modelRegistry,
        model: spec.model,
        agentDir: spec.agentDir,
        repo: spec.repo,
        runsDir: spec.runsDir,
        onRun: (handle, engine) => {
          if (!ui) return;
          ui.follow(handle, engine);
          const first = handle.view().order[0];
          void ui.openDetail({ id: handle.id, dir: handle.dir, view: handle.view() }, first, ctx);
        },
      });
      // The open detail view must show the agent's brief and its streamed answer.
      let shown = "";
      if (ui?.detail) {
        await ui.detail.sync();
        shown = ui.detail.render(120).join("\n");
        ui.detail.offset = Number.MAX_SAFE_INTEGER; // the top of the conversation
        shown += ui.detail.render(120).join("\n");
      }
      const opened = {
        mode: ctx.mode,
        detailOpen: !!ui?.detail,
        detailShows: {
          brief: /\[bench:/.test(shown),
          streamed: /The benchmark streams this sentence/.test(shown),
        },
      };
      ui?.dispose();
      writeFileSync(spec.out, JSON.stringify({ ...raw, firstRequest, ...opened }));
    } catch (error) {
      writeFileSync(spec.out, JSON.stringify({ error: (error as Error).stack ?? String(error) }));
    }
    ctx.shutdown();
  };
  pi.registerCommand("pinata-bench", {
    description: "Run one engine bench scenario in this Pi",
    handler: (_args, ctx) => bench(ctx),
  });
  if (spec.tui)
    pi.on("session_start", (_event, ctx) => {
      // Let the interactive TUI finish starting before the run begins.
      setTimeout(() => void bench(ctx), 500);
    });
}
