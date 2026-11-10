import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveExecutable } from "./doctor.ts";
import { defaultCondition, defaultLimits } from "./runner.ts";

export async function bootstrap(args: string[]): Promise<void> {
  let directory = join(dirname(fileURLToPath(import.meta.url)), "local");
  let provider = "openai";
  let model = "gpt-6-luna";
  let thinking = "max";
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--help") {
      console.log(
        "arena:bootstrap [--out DIR] [--provider ID] [--model ID] [--thinking LEVEL]. Overwrites generated v2 native configs; makes no model calls.",
      );
      return;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--out") directory = resolve(value);
    else if (flag === "--provider") provider = value;
    else if (flag === "--model") model = value;
    else if (flag === "--thinking") thinking = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  await mkdir(directory, { recursive: true });
  for (const system of ["codex", "pi", "pinata"] as const) {
    const explicit = system === "codex" ? process.env.ARENA_CODEX_BIN : process.env.PINATA_PI;
    const command = await resolveExecutable(explicit ?? (system === "codex" ? "codex" : "pi"), {
      excludeNodeModules: !explicit,
    });
    const adapter = { kind: "native", system, command, args: [] } as const;
    const requested = {
      ...defaultCondition({ ...adapter, args: [] }, "native"),
      model: { provider, id: model, version: null, settings: { thinking, concurrency: 4 } },
    };
    const config = {
      schemaVersion: 2,
      adapter,
      condition: requested,
      limits: { ...defaultLimits, timeoutMs: 1200000, oracleTimeoutMs: 60000 },
    };
    const path = join(directory, `${system}.json`);
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(`Configured ${path}: ${command}`);
  }
  console.log(
    "No model calls made. Native adapters remain unverified until independently attested.",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await bootstrap(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
