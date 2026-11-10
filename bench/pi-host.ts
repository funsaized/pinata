import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installCoordinatorUi, type CoordinatorUi } from "../engine/ui/pi.ts";
import type { RuntimeSource } from "../engine/sources/runtime.ts";
import { publishImmutable } from "../engine/storage/io.ts";
import { runCell } from "./engine.ts";
import { cellSpecSchema } from "./types.ts";
import { failedResult, writeResult } from "./host.ts";

export default function extension(pi: ExtensionAPI): void {
  const path = process.env.PINATA_BENCH_SPEC;
  if (!path) throw new Error("Benchmark extension requires an allocated specification");
  const local = fauxProvider({
    provider: "pinata-benchmark-host",
    models: [{ id: "offline", contextWindow: 200_000, maxTokens: 8192 }],
  });
  pi.registerProvider(local.provider);
  let running = false;
  const perform = async (context: ExtensionContext): Promise<void> => {
    if (running) return;
    running = true;
    const spec = cellSpecSchema.parse(JSON.parse(await readFile(path, "utf8")));
    let ui: CoordinatorUi | undefined;
    let source: RuntimeSource | undefined;
    let opened = false;
    let opening: Promise<void> | undefined;
    try {
      const result = await runCell(spec, {
        async onRuntime(runtimeSource) {
          source = runtimeSource;
          if (spec.host !== "tui" || !spec.viewer) return;
          if (context.mode !== "tui")
            throw new Error("Requested TUI benchmark did not enter Pi terminal mode");
          ui = installCoordinatorUi(pi, async () => {
            if (!source) throw new Error("Benchmark source unavailable");
            return source;
          });
          await ui.bind(context, runtimeSource);
          opening = ui.open(context, "fleet", undefined, runtimeSource);
          opened = true;
          void opening.catch(() => {});
        },
      });
      ui?.dispose(context);
      await opening;
      await publishImmutable(
        join(spec.directory, "pi-host.json"),
        Buffer.from(JSON.stringify({ mode: context.mode, opened, painted: false, errors: [] })),
        "benchmark-pi-host",
      );
      await writeResult(spec, result);
    } catch (error) {
      ui?.dispose(context);
      await opening?.catch(() => {});
      await writeResult(spec, await failedResult(spec, error));
    }
    context.shutdown();
  };
  pi.registerCommand("pinata-benchmark", {
    description: "Run an allocated local benchmark cell",
    handler: (_args, context) => perform(context),
  });
  pi.on("session_start", (_event, context) => {
    if (context.mode === "tui")
      setTimeout(() => {
        void perform(context);
      }, 50);
  });
}
