// The in-process backend: each agent is a Pi SDK AgentSession in the parent's process, sharing
// one child model runtime. About 1 ms and 1 MB per agent, with Pi's own prompt, tools,
// retries and compaction.
import { statSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createCodemodeExtension,
  loadProjectContextFiles,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { agentExtension, SUBMIT } from "../agent/extension.ts";
import { REMINDER } from "../agent/brief.ts";
import { appendJsonl, writeJsonl } from "../core/store.ts";
import { ZERO_USAGE, addUsage } from "../core/types.ts";
import type { AgentEventInput, ThinkingLevel, ToolRecord } from "../core/types.ts";
import { argsPreview, sessionMapper } from "../sources/session.ts";
import type {
  AgentBackend,
  AgentHandle,
  AgentLaunch,
  AgentOutcome,
  AgentResult,
  AgentSnapshot,
  StopReason,
  Usage,
} from "./types.ts";

export interface InProcessOptions {
  // The shared child model runtime (pi/runtime.ts).
  runtime: () => Promise<ModelRuntime>;
  agentDir: string;
  // The parent's retry settings and shell settings, so children behave like the parent.
  retry?: Record<string, unknown>;
  shellPath?: string;
  shellCommandPrefix?: string;
  // pi-web-access entry file, loaded for research agents.
  webExtension?: string | null;
  // The repository root, so worktrees inside .git do not load the main checkout's context files twice.
  repoRoot?: string;
}

type ContextFile = { path: string; content: string };

// AGENTS.md and other context files per cwd, reused while the files' mtimes are unchanged.
export class ContextFileCache {
  private readonly entries = new Map<
    string,
    { files: ContextFile[]; stamps: Array<[string, number]> }
  >();

  get(cwd: string, agentDir: string, repoRoot?: string): ContextFile[] {
    const key = `${cwd}\0${agentDir}`;
    const hit = this.entries.get(key);
    if (hit && hit.stamps.every(([p, m]) => mtime(p) === m)) return hit.files;
    let files = loadProjectContextFiles({ cwd, agentDir });
    // A worktree under <repo>/.git would otherwise also load the main checkout's copies.
    if (repoRoot && resolve(cwd) !== resolve(repoRoot) && inside(repoRoot, cwd))
      files = files.filter((f) => !inside(repoRoot, f.path) || inside(cwd, f.path));
    this.entries.set(key, { files, stamps: files.map((f) => [f.path, mtime(f.path)]) });
    return files;
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function partialText(message: any): { text: string; thinking: string } | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  let text = "";
  let thinking = "";
  for (const c of message.content) {
    if (c?.type === "text") text += c.text ?? "";
    if (c?.type === "thinking") thinking += c.thinking ?? "";
  }
  return { text, thinking };
}

export class InProcessBackend implements AgentBackend {
  readonly kind = "in-process" as const;
  private readonly options: InProcessOptions;
  readonly contextFiles = new ContextFileCache();

  constructor(options: InProcessOptions) {
    this.options = options;
  }

  async start(
    launch: AgentLaunch,
    sink: (e: AgentEventInput) => void,
    signal: AbortSignal,
  ): Promise<AgentHandle> {
    const options = this.options;
    const runtime = await options.runtime();
    const model = runtime.getModel(launch.model.provider, launch.model.id);
    if (!model)
      throw new Error(`Model ${launch.model.provider}/${launch.model.id} is not available`);
    let result: AgentResult | null = null;
    const prefix = ["export PINATA_AGENT=1", options.shellCommandPrefix].filter(Boolean).join("\n");
    const settingsManager = SettingsManager.inMemory({
      ...(options.retry && { retry: options.retry }),
      compaction: { enabled: true },
      shellCommandPrefix: prefix,
      ...(options.shellPath && { shellPath: options.shellPath }),
    });
    const contextFiles = this.contextFiles.get(
      launch.cwd,
      options.agentDir,
      launch.root ?? options.repoRoot,
    );
    const web = launch.webExtension ?? options.webExtension;
    const research = launch.task.role === "research" && web;
    const loader = new DefaultResourceLoader({
      cwd: launch.cwd,
      agentDir: options.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        agentExtension(
          { ...launch.agent, codemode: launch.codemode },
          { result: (r) => (result = r) },
        ),
        ...(launch.codemode ? [createCodemodeExtension()] : []),
      ],
      ...(research && { additionalExtensionPaths: [web] }),
      appendSystemPromptOverride: () => [launch.persona],
      agentsFilesOverride: () => ({ agentsFiles: contextFiles }),
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: launch.cwd,
      agentDir: options.agentDir,
      model,
      thinkingLevel: launch.model.thinking as ThinkingLevel,
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(launch.cwd),
      settingsManager,
      tools: [...launch.tools, SUBMIT, ...(launch.codemode ? ["codemode"] : [])],
    });
    return attach(session, launch, sink, signal, () => result);
  }
}

// Wires a session to the engine: events, prompting, steering, snapshot and transcript.
function attach(
  session: AgentSession,
  launch: AgentLaunch,
  sink: (e: AgentEventInput) => void,
  signal: AbortSignal,
  submitted: () => AgentResult | null,
): AgentHandle {
  const mapper = sessionMapper();
  let usage: Usage = ZERO_USAGE;
  let partial: any;
  const inFlight = new Map<string, ToolRecord>();
  const live = launch.mode === "observe" && launch.transcript;
  let writes: Promise<void> = Promise.resolve();
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "message_update") partial = event.message;
    if (event.type === "message_end") {
      partial = undefined;
      if (live)
        writes = writes.then(() => appendJsonl(launch.transcript!, event.message)).catch(() => {});
    }
    if (event.type === "tool_execution_start")
      inFlight.set(event.toolCallId, {
        call: event.toolCallId,
        name: event.toolName,
        args: argsPreview(event.toolName, event.args),
      });
    if (event.type === "tool_execution_end") inFlight.delete(event.toolCallId);
    for (const e of mapper.map(event)) {
      if (e.t === "message_end" && e.usage) usage = addUsage(usage, e.usage);
      sink(e);
    }
  });
  if (live)
    writes = appendJsonl(launch.transcript!, {
      role: "user",
      content: launch.brief,
      timestamp: Date.now(),
    }).catch(() => {});
  const onAbort = () => void session.abort().catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const run = async (): Promise<AgentOutcome> => {
    let error: string | undefined;
    try {
      if (!signal.aborted) await session.prompt(launch.brief, { expandPromptTemplates: false });
      const last = mapper.lastAssistant;
      // One reminder in the same session keeps the prompt cache warm.
      if (
        !submitted() &&
        !signal.aborted &&
        last?.stopReason !== "error" &&
        last?.stopReason !== "aborted" &&
        mapper.turns < launch.budgets.maxTurns
      )
        await session.prompt(REMINDER, { expandPromptTemplates: false });
    } catch (e) {
      error = (e as Error).message;
    }
    const last = mapper.lastAssistant;
    if (!error && last?.stopReason === "error") error = last.errorMessage ?? "provider error";
    const result = submitted();
    const stopReason: StopReason = result
      ? "submitted"
      : signal.aborted
        ? "aborted"
        : error
          ? "error"
          : "no_result";
    return {
      result,
      stopReason,
      ...(stopReason === "error" && { error }),
      ...(stopReason === "no_result" && {
        error: "The agent finished without calling submit_result",
      }),
      usage,
      turns: mapper.turns,
      toolCalls: mapper.toolCalls,
      ...(last && { model: { provider: last.provider, id: last.model } }),
    };
  };
  const done = run();
  let disposed = false;
  return {
    done,
    async steer(text) {
      await session.steer(text);
    },
    async followUp(text) {
      await session.followUp(text);
    },
    async abort() {
      await session.abort();
    },
    async snapshot(): Promise<AgentSnapshot> {
      return {
        meta: {
          run: launch.run,
          agent: launch.task.id,
          role: launch.task.role,
          backend: "in-process",
        },
        status: "running",
        messages: [...session.messages],
        ...(partial && { streaming: partialText(partial) }),
        toolsInFlight: [...inFlight.values()],
        usage,
        counters: { turns: mapper.turns, toolCalls: mapper.toolCalls },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", onAbort);
      await done.catch(() => {});
      if (launch.transcript && !live)
        await writeJsonl(launch.transcript, session.messages).catch(() => {});
      await writes;
      unsubscribe();
      session.dispose();
    },
  };
}
