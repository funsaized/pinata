import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapterConfigSchema, nativeInvocation } from "./adapters.ts";
import { freezeTask, loadTask } from "./corpus.ts";
import { EvidenceStore } from "./evidence.ts";
import { runMatrix } from "./matrix.ts";
import { defaultLimits } from "./runner.ts";

export async function localRun(args: string[]): Promise<string | undefined> {
  const arena = dirname(fileURLToPath(import.meta.url));
  let system = "codex";
  let taskId = "team-board";
  let trials = 1;
  let allowExternal = false;
  let preview = false;
  let configDirectory = join(arena, "local");
  let out = resolve("arena/results");
  let concurrency: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--allow-external") {
      allowExternal = true;
      continue;
    }
    if (flag === "--preview") {
      preview = true;
      continue;
    }
    if (flag === "--help") {
      console.log(
        "arena:local --agent codex|pi|pinata|all [--task team-board|checkout|reservations|incidents|all] [--trials N] [--concurrency N] [--configs DIR] [--out DIR] --allow-external\nUse --preview to print exact commands and prompts without launching models.",
      );
      return;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--agent") system = value;
    else if (flag === "--task") taskId = value;
    else if (flag === "--trials") trials = Number(value);
    else if (flag === "--concurrency") concurrency = Number(value);
    else if (flag === "--configs") configDirectory = resolve(value);
    else if (flag === "--out") out = resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  const names = system === "all" ? ["codex", "pi", "pinata"] : [system];
  if (names.some((name) => !["codex", "pi", "pinata"].includes(name)))
    throw new Error("Unknown native system");
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1))
    throw new Error("Worker count must be positive");
  const conditions = [];
  let limits = { ...defaultLimits, timeoutMs: 1200000, oracleTimeoutMs: 60000 };
  for (const name of names) {
    const config = adapterConfigSchema.parse(
      JSON.parse(await readFile(join(configDirectory, `${name}.json`), "utf8")),
    );
    if (config.adapter.kind !== "native")
      throw new Error("Local pilot requires native adapter configurations");
    const requested = config.condition;
    if (!requested.model) throw new Error("Native configuration needs an explicit model");
    if (concurrency !== undefined) requested.model.settings.concurrency = concurrency;
    if (config.limits) limits = config.limits;
    conditions.push({ name, adapter: config.adapter, requested });
  }
  const tasks =
    taskId === "all"
      ? ["checkout", "reservations", "incidents", "team-board"].map((id) => ({ id }))
      : [{ id: taskId }];
  if (preview) {
    const directory = await mkdtemp(join(tmpdir(), "pinata-arena-preview-"));
    try {
      const store = new EvidenceStore(join(directory, "artifacts"));
      for (const condition of conditions)
        for (const definition of tasks) {
          const task = await freezeTask(await loadTask(definition.id), store);
          const invocation = nativeInvocation({
            adapter: condition.adapter,
            task,
            candidate: "/PREVIEW/candidate",
            directory: "/PREVIEW/evidence",
            requested: condition.requested,
            limits,
          });
          console.log(
            JSON.stringify({ command: invocation.command, args: invocation.args }, null, 2),
          );
        }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return;
  }
  if (!allowExternal)
    throw new Error(
      "Native model calls require --allow-external; use --preview for a no-call review",
    );
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await runMatrix(
      { schemaVersion: 2, rounds: trials, tasks, conditions, limits },
      { out, repositoryRoot: process.cwd(), allowExternal, signal: controller.signal },
    );
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const path = await localRun(process.argv.slice(2));
    if (path) console.log(`Matrix retained: ${path}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
