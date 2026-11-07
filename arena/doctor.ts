import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdapterConfig } from "./runner.ts";
import { nativeInvocation, configuredExecutable, type NativeAgent } from "./adapters/native.ts";
import { projectTasks } from "./corpus/index.ts";

const arena = dirname(fileURLToPath(import.meta.url));
let failed = false;
console.log(`OK: Node ${process.version}`);
for (const command of ["git", process.env.ARENA_CHROMIUM_BIN ?? "chromium"]) {
  const version = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (version.status !== 0) {
    console.error(
      `FAIL: ${command} could not start. ${version.error?.message ?? "Check your installation."}`,
    );
    failed = true;
  } else console.log(`OK: ${(version.stdout.trim() || version.stderr.trim()).split("\n")[0]}`);
}
for (const name of ["codex", "pi", "pinata"] as NativeAgent[]) {
  try {
    const config = parseAdapterConfig(
      JSON.parse(readFileSync(join(arena, "local", `${name}.json`), "utf8")),
    );
    const task = projectTasks[0]!;
    nativeInvocation(
      name,
      {
        schemaVersion: 1,
        runId: "doctor",
        task: { id: task.id, version: task.version, prompt: task.prompt, units: task.units },
        workflow: "native",
        cwd: arena,
        evidenceDir: join(arena, "local"),
        startingRevision: "doctor",
        model: config.model ?? null,
        limits: { timeoutMs: config.timeoutMs ?? 1200000, maxRepairs: 1 },
      },
      configuredExecutable(config.args),
    );
    for (const path of [config.command, config.args?.[0]])
      if (!path || !existsSync(path)) throw new Error(`Missing executable or adapter: ${path}`);
    const executable = configuredExecutable(config.args);
    if (!executable) throw new Error("Agent executable is not pinned");
    const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10000 });
    if (version.status !== 0) throw new Error(`Cannot start ${executable}`);
    console.log(`OK: ${name} executable ${executable}: ${version.stdout.trim().split("\n")[0]}`);
    console.log(`OK: ${name} native config (${config.model?.provider}/${config.model?.id})`);
  } catch (error) {
    failed = true;
    console.error(
      `FAIL: ${name} config: ${String(error)}. Regenerate with npm run arena:bootstrap.`,
    );
  }
}
console.log(
  "No model calls made. Authentication, model access and live delegation are not validated by this check.",
);
if (failed) process.exitCode = 1;
