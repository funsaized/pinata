import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configLayerSchema } from "../engine/contracts/index.ts";
import { conditionSchema } from "./contracts.ts";
import { createPinataExtension } from "../engine/pi/extension.ts";

export default function arenaExtension(pi: ExtensionAPI): void | Promise<void> {
  const file = process.env.PINATA_ARENA_REQUEST;
  if (!file) throw new Error("Native arena request is missing");
  const request = JSON.parse(readFileSync(file, "utf8"));
  const requested = conditionSchema.parse(request.requested);
  if (!requested.model) throw new Error("Arena requires an explicit model");
  const model = {
    provider: requested.model.provider,
    id: requested.model.id,
    thinking: requested.model.settings.thinking ?? "high",
  };
  const config = configLayerSchema.parse({
    backend: requested.backend,
    workspace: requested.workspace,
    mode: requested.observation,
    models: { default: model },
    fallbacks: { default: [] },
    setup: false,
  });
  return createPinataExtension({
    host: {
      workspace: request.candidate,
      directory: join(request.evidenceDirectory, "runtime"),
      run: request.cell,
      definitionDirectories: [fileURLToPath(new URL("../agents/", import.meta.url))],
      config: { run: config },
    },
  })(pi);
}
