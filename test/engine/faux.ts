// A faux-provider world for engine tests: pi-ai's faux provider registered the way an
// extension would register it, a child model runtime, an in-process backend and a git repo.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  createAssistantMessageEventStream,
  createFauxCore,
  createProvider,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InProcessBackend } from "../../engine/backends/in-process.ts";
import { createEngine, type RunOptions } from "../../engine/core/engine.ts";
import { Limiter } from "../../engine/core/limiter.ts";
import { RuntimeCache } from "../../engine/pi/runtime.ts";
import { piPipeline, type PipelineStages, type PiRunData } from "../../engine/pi/pipeline.ts";
import { randomUUID } from "node:crypto";
import { validateConfig } from "../../engine/pi/config.ts";
import { validateGraph } from "../../engine/core/validate.ts";
import { prepareRun, verificationStages } from "../../engine/verify/stages.ts";
import type { ModelRef, TaskSpec } from "../../engine/core/types.ts";
import { tempDir } from "./helpers.ts";

export interface FauxTurn {
  agent: string | null;
  role: string | null;
  round: number;
  tools: string[];
  system: string;
  text: string;
  context: any;
}

export const MODEL: ModelRef = { provider: "faux", id: "faux-1", thinking: "off" };

export function gitRepo(
  dir: string,
  files: Record<string, string> = { "README.md": "# Fixture\n" },
) {
  const run = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  return {
    async init() {
      await mkdir(dir, { recursive: true });
      for (const [file, content] of Object.entries(files)) {
        await mkdir(join(dir, file, ".."), { recursive: true });
        await writeFile(join(dir, file), content);
      }
      run("init", "-q");
      run("add", "-A");
      run(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "init",
      );
    },
    git: run,
  };
}

// pi-ai's faux provider reports zero cost. This wrapper lets a response carry `testCost`
// (dollars), set as the response's cost, so cost budgets can be tested.
export function pricedFaux() {
  const core = createFauxCore({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8192 }],
  });
  const streamSimple = (model: any, context: any, options: any) => {
    const inner = core.streamSimple(model, context, options);
    const out = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of inner) {
        const message =
          event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
        const price = (message as { testCost?: number } | undefined)?.testCost;
        if (message && price !== undefined)
          message.usage = { ...message.usage, cost: { ...message.usage.cost, total: price } };
        out.push(event);
      }
      out.end();
    })();
    return out;
  };
  const provider = createProvider({
    id: core.provider,
    auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
    models: core.models,
    api: {
      stream: core.stream,
      streamSimple,
      fetchDeferred: core.fetchDeferred,
      cancelDeferred: core.cancelDeferred,
    },
  } as any);
  return { ...core, provider };
}

// The faux provider sees a transcript: system messages carry the prompt and tool changes.
function turnInfo(context: any): FauxTurn {
  const messages: any[] = context.messages ?? [];
  const tools = new Set<string>();
  const system: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") continue;
    system.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    for (const section of Object.values(m.sections ?? {}))
      if (typeof section === "string") system.push(section);
    for (const tool of m.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of m.toolsRemoved ?? []) tools.delete(tool.name ?? tool);
  }
  const part = (c: any) => (c?.type === "text" ? c.text : JSON.stringify(c));
  const text = messages
    .filter((m) => m.role !== "system")
    .map((m) =>
      typeof m.content === "string" ? m.content : (m.content ?? []).map(part).join("\n"),
    )
    .join("\n");
  const m = /# Task ([a-z][a-z0-9-]*) \(([a-z]+)\)/.exec(text);
  return {
    agent: m?.[1] ?? null,
    role: m?.[2] ?? null,
    round: messages.filter((x) => x.role === "assistant").length,
    tools: [...tools].sort(),
    system: system.join("\n"),
    text,
    context,
  };
}

export async function fauxWorld(
  t: TestContext,
  respond: (turn: FauxTurn) => AssistantMessage | Promise<AssistantMessage>,
  options: { stages?: PipelineStages; files?: Record<string, string> } = {},
) {
  const dir = await tempDir(t, "pinata-faux-");
  const agentDir = join(dir, "agent");
  const repo = join(dir, "repo");
  await mkdir(agentDir, { recursive: true });
  const fixture = gitRepo(repo, options.files);
  await fixture.init();
  const turns: FauxTurn[] = [];
  const faux = pricedFaux();
  const step = async (context: any) => {
    const turn = turnInfo(context);
    turns.push(turn);
    return respond(turn);
  };
  faux.setResponses(Array.from({ length: 20_000 }, () => step));
  // The parent: a registry with the faux provider registered by "an extension".
  const parent = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const registry = new ModelRegistry(parent);
  registry.registerProvider(faux.provider);
  // A registered provider counts as configured after the asynchronous availability refresh.
  await registry.refresh({ allowNetwork: false });
  const cache = new RuntimeCache(agentDir);
  const backend = new InProcessBackend({
    runtime: () => cache.get(registry),
    agentDir,
    repoRoot: repo,
  });
  const engine = createEngine({
    backends: { "in-process": backend },
    pipeline: piPipeline(options.stages ?? verificationStages()),
    limiter: new Limiter({ cap: 64, initial: 64 }),
  });
  let n = 0;
  const run = async (
    tasks: TaskSpec[],
    opts: RunOptions & {
      data?: Partial<PiRunData> & Record<string, unknown>;
      config?: Record<string, unknown>;
    } = {},
  ) => {
    const id = opts.id ?? randomUUID();
    const config = validateConfig({ setup: false, ...opts.config }).config;
    const prep = await prepareRun(repo, id, validateGraph(tasks, { allowWrites: true }), config);
    return engine.run(tasks, {
      cwd: repo,
      dir: join(dir, "runs", `run-${++n}`),
      ...opts,
      id,
      data: {
        models: Object.fromEntries(tasks.map((task) => [task.id, MODEL])),
        instructions: [],
        codemode: false,
        backend: "in-process",
        config,
        prep,
        ...opts.data,
      },
    });
  };
  return { dir, agentDir, repo, fixture, faux, registry, cache, backend, engine, run, turns };
}
