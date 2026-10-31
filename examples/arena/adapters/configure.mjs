// Writes a reviewable configuration; never starts a provider or contestant.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { validateLiveConfig } from "../runner.ts";
const { values } = parseArgs({
  options: {
    "image-file": { type: "string", default: "/tmp/pinata-arena-adapter-image.json" },
    out: { type: "string" },
    task: { type: "string" },
    "base-url": { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    "api-key-env": { type: "string" },
    "ca-file": { type: "string" },
    pricing: { type: "string" },
    track: { type: "string", default: "controlled-same-model" },
    trials: { type: "string", default: "1" },
  },
});
for (const key of ["out", "task", "base-url", "provider", "model", "api-key-env"])
  if (!values[key]) throw Error(`--${key} is required`);
const url = new URL(values["base-url"]);
if (
  !["http:", "https:"].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
)
  throw Error("Use an HTTP(S) provider URL without credentials, query or fragment");
const image = JSON.parse(await readFile(values["image-file"], "utf8"));
const pricing = values.pricing ? JSON.parse(await readFile(values.pricing, "utf8")) : undefined;
const c = {
  track: values.track,
  model: { provider: values.provider, id: values.model },
  task: values.task,
  trials: Number(values.trials),
  seed: 7,
  limits: { generationMs: 120000, verificationMs: 10000, costUsd: 1, outputBytes: 1048576 },
  contestants: ["pinata", "opencode", "pi-example"].map((id) => ({
    id,
    image: image.image,
    command: ["node", "/opt/arena-adapters/run.mjs", id],
    version:
      id === "opencode"
        ? "OpenCode 2.2.5"
        : id === "pinata"
          ? "patched Piñata 2.0.1 + Pi 1.4.0"
          : "Pi 1.4.0 official subagent example",
    source: JSON.stringify({
      pins: image.pins,
      sources: image.sources,
      pinataSources: image.pinataSources,
      sourceCommit: image.sourceCommit,
      sourceDirty: image.sourceDirty,
    }),
    network: "bridge",
    secrets: [values["api-key-env"]],
    ...(values["ca-file"] && { caFile: values["ca-file"] }),
    settings: {
      baseUrl: values["base-url"],
      apiKeyEnv: values["api-key-env"],
      thinking: "off",
      memoryMb: 1024,
      ...(pricing && { pricing }),
    },
  })),
};
validateLiveConfig(c);
await writeFile(values.out, JSON.stringify(c, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(
  `Configuration saved to ${values.out}. Inspect it and provider limits before an explicitly authorized live run.`,
);
