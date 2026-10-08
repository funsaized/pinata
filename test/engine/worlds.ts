// Backend conformance worlds: one scripted model, played by pi-ai's faux provider for the
// in-process backend and by the loopback OpenAI-compatible server for `pi --mode rpc`
// children (the process backend). Children use the exact Pi devDependency's CLI unless
// PINATA_PI names another Pi.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ProcessBackend } from "../../engine/backends/process.ts";
import { createEngine, type RunOptions } from "../../engine/core/engine.ts";
import { Limiter } from "../../engine/core/limiter.ts";
import type { ModelRef, TaskSpec } from "../../engine/core/types.ts";
import { validateGraph } from "../../engine/core/validate.ts";
import { validateConfig } from "../../engine/pi/config.ts";
import { piPipeline, type PiRunData } from "../../engine/pi/pipeline.ts";
import { prepareRun, verificationStages } from "../../engine/verify/stages.ts";
import {
  LOOPBACK_MODEL,
  LOOPBACK_PROVIDER,
  startLoopback,
} from "../../bench/providers/loopback.ts";
import { fauxWorld, gitRepo } from "./faux.ts";
import { tempDir } from "./helpers.ts";

export interface Turn {
  agent: string | null;
  role: string | null;
  round: number;
  tools: string[];
  system: string;
  text: string;
}

export interface Reply {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export type Script = (turn: Turn) => Reply | Promise<Reply>;

export interface WorldOptions {
  files?: Record<string, string>;
  priced?: boolean;
}

export interface World {
  kind: "in-process" | "process";
  dir: string;
  repo: string;
  turns: Turn[];
  run(
    tasks: TaskSpec[],
    opts?: RunOptions & { data?: Partial<PiRunData> & Record<string, unknown> },
  ): ReturnType<ReturnType<typeof createEngine>["run"]>;
  engine: ReturnType<typeof createEngine>;
  backend?: ProcessBackend;
}

// OpenAI message content: a string or text parts; tool calls and results as JSON.
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((part: any) => (part?.type === "text" ? part.text : JSON.stringify(part)))
    .join("\n");
}

const TASK = /# Task ([a-z][a-z0-9-]*) \(([a-z]+)\)/;

export async function inProcessWorld(
  t: TestContext,
  script: Script,
  options: WorldOptions = {},
): Promise<World> {
  const turns: Turn[] = [];
  const world = await fauxWorld(
    t,
    async (turn) => {
      const info: Turn = {
        agent: turn.agent,
        role: turn.role,
        round: turn.round,
        tools: turn.tools,
        system: turn.system,
        text: turn.text,
      };
      turns.push(info);
      const reply = await script(info);
      const parts = [
        ...(reply.text ? [fauxText(reply.text)] : []),
        ...(reply.toolCalls ?? []).map((c) => fauxToolCall(c.name, c.arguments as never)),
      ];
      const message = fauxAssistantMessage(parts, {
        stopReason: reply.toolCalls?.length ? "toolUse" : "stop",
      });
      // A priced world: every model response costs more than a 1 USD run limit.
      return options.priced ? Object.assign(message, { testCost: 1.5 }) : message;
    },
    { files: options.files },
  );
  return {
    kind: "in-process",
    dir: world.dir,
    repo: world.repo,
    turns,
    run: world.run,
    engine: world.engine,
  };
}

function devPi(): string[] {
  if (process.env.PINATA_PI) return [];
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return [process.execPath, join(dirname(entry), "cli.js")];
}

export const LOOPBACK: ModelRef = {
  provider: LOOPBACK_PROVIDER,
  id: LOOPBACK_MODEL,
  thinking: "off",
};

export async function processWorld(
  t: TestContext,
  script: Script,
  options: WorldOptions = {},
): Promise<World> {
  const dir = await tempDir(t, "pinata-process-");
  const agentDir = join(dir, "agent");
  const repo = join(dir, "repo");
  await gitRepo(repo, options.files).init();
  const turns: Turn[] = [];
  const loopback = await startLoopback({
    tokenDelayMs: 0,
    responder: async ({ body, text }) => {
      const messages: any[] = body.messages ?? [];
      const system = messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => contentText(m.content))
        .join("\n");
      const rest = text;
      const m = TASK.exec(rest);
      const turn: Turn = {
        agent: m?.[1] ?? null,
        role: m?.[2] ?? null,
        round: messages.filter((x) => x.role === "assistant").length,
        tools: ((body.tools ?? []) as any[]).map((x) => x.function?.name ?? x.name).sort(),
        system,
        text: messages
          .filter((x) => x.role !== "system" && x.role !== "developer")
          .map((x) => contentText(x.content))
          .join("\n"),
      };
      turns.push(turn);
      return script(turn);
    },
  });
  t.after(() => loopback.close());
  // Priced: one prompt token costs 1 USD, so the first response exceeds a 1 USD limit.
  await loopback.writeModels(agentDir, options.priced ? 1_000_000 : 0);
  const command = devPi();
  const backend = new ProcessBackend({
    env: { PI_CODING_AGENT_DIR: agentDir },
    ...(command.length && { command }),
  });
  const engine = createEngine({
    backends: { process: backend },
    pipeline: piPipeline(verificationStages()),
    limiter: new Limiter({ cap: 64, initial: 64 }),
  });
  let n = 0;
  const run: World["run"] = async (tasks, opts = {}) => {
    const id = opts.id ?? randomUUID();
    const config = validateConfig({ setup: false, ...(opts as any).config }).config;
    const prep = await prepareRun(repo, id, validateGraph(tasks, { allowWrites: true }), config);
    return engine.run(tasks, {
      cwd: repo,
      dir: join(dir, "runs", `run-${++n}`),
      ...opts,
      id,
      data: {
        models: Object.fromEntries(tasks.map((task) => [task.id, LOOPBACK])),
        instructions: [],
        codemode: false,
        backend: "process",
        config,
        prep,
        ...opts.data,
      },
    });
  };
  return { kind: "process", dir, repo, turns, run, engine, backend };
}
