import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { adapterConfigSchema, type Adapter } from "./adapters.ts";
import { type Artifact, type Limits } from "./contracts.ts";
import { EvidenceStore } from "./evidence.ts";
import { runProcess } from "./process.ts";
import { supervisionCapability } from "../engine/backends/supervision/index.ts";

export async function resolveExecutable(
  command: string,
  options: { excludeNodeModules?: boolean } = {},
): Promise<string> {
  const names =
    process.platform === "win32"
      ? [
          command,
          ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
            .split(";")
            .map((extension) => `${command}${extension.toLowerCase()}`),
        ]
      : [command];
  const roots = isAbsolute(command)
    ? [""]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter((path) => !options.excludeNodeModules || !path.includes("node_modules"));
  for (const root of roots)
    for (const name of names) {
      const path = root ? join(root, name) : name;
      try {
        await access(path, constants.X_OK);
        if ((await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink())
          return realpath(path);
      } catch {
        /* Continue through the configured search path. */
      }
    }
  throw new Error(`Executable is unavailable: ${command}`);
}
export async function inspectAdapter(
  adapter: Adapter,
  options: { directory: string; store: EvidenceStore; limits: Limits },
): Promise<{ available: boolean; evidence: Artifact[]; reasons: string[] }> {
  if (adapter.kind === "offline") return { available: true, evidence: [], reasons: [] };
  const capability = supervisionCapability();
  if (!capability.available)
    return {
      available: false,
      evidence: [],
      reasons: [capability.reason ?? "Process supervision unavailable"],
    };
  const executable = await resolveExecutable(adapter.command);
  const binary = await options.store.put(await readFile(executable));
  const execution = await runProcess({
    directory: join(options.directory, "version-supervisor"),
    command: executable,
    args: [...adapter.args, "--version"],
    cwd: options.directory,
    store: options.store,
    limits: options.limits,
    timeoutMs: 10000,
  });
  const record = await options.store.json({
    schemaVersion: 1,
    executable,
    binary,
    versionOutput: execution.stdout.toString().trim(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    dependencyCoverage: "partial",
    limitations: [
      "Executable content is captured; dynamic imports, plugins, environment and remote model versions require separate evidence",
    ],
  });
  return {
    available:
      execution.state === "completed" &&
      execution.exit.code === 0 &&
      execution.cleanup.status === "stopped",
    evidence: [binary, record, ...execution.evidence],
    reasons: execution.exit.code === 0 ? [] : ["Executable version preflight failed"],
  };
}

export async function doctor(configDirectory: string, evidenceDirectory: string): Promise<boolean> {
  await mkdir(evidenceDirectory, { recursive: true });
  const store = new EvidenceStore(join(evidenceDirectory, "artifacts"));
  const limits = {
    timeoutMs: 10000,
    oracleTimeoutMs: 10000,
    cleanupMs: 2000,
    maxRepairs: 0,
    maxLogBytes: 1024 * 1024,
  };
  let available = true;
  for (const system of ["codex", "pi", "pinata"]) {
    try {
      const config = adapterConfigSchema.parse(
        JSON.parse(await readFile(join(configDirectory, `${system}.json`), "utf8")),
      );
      const directory = join(evidenceDirectory, system);
      await mkdir(directory);
      const inspected = await inspectAdapter(config.adapter, { directory, store, limits });
      available &&= inspected.available;
      console.log(
        `${inspected.available ? "OK" : "FAIL"}: ${system}; ${inspected.reasons.join("; ")}`,
      );
    } catch (error) {
      available = false;
      console.error(`FAIL: ${system}: ${String(error)}`);
    }
  }
  for (const command of ["git", process.env.ARENA_CHROMIUM_BIN ?? "chromium"]) {
    try {
      console.log(`OK: ${command}: ${await resolveExecutable(command)}`);
    } catch (error) {
      available = false;
      console.error(String(error));
    }
  }
  console.log(
    `Node ${process.version}, ${process.platform}/${process.arch}. Evidence: ${evidenceDirectory}`,
  );
  console.log(
    "No model calls made. Authentication, model availability and native delegation are unverified.",
  );
  return available;
}
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    const available = await doctor(
      process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "local"),
      process.argv[3] ?? join("arena/results", `doctor-${randomUUID()}`),
    );
    if (!available) process.exitCode = 1;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
