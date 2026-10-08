// The process backend: each agent is a `pi --mode rpc` child with 0.7.0's flags, the agent
// extension, and its persona and options in files under <run>/agents/<task>/. Its JSONL
// event stream maps to AgentEvents through the same mapper as in-process sessions; the
// result arrives in submit_result's tool result details (`pinataResult`).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REMINDER } from "../agent/brief.ts";
import { SUBMIT } from "../agent/extension.ts";
import { appendJsonl, writeJsonl } from "../core/store.ts";
import { ZERO_USAGE, addUsage } from "../core/types.ts";
import type { AgentEventInput, ToolRecord } from "../core/types.ts";
import { argsPreview } from "../sources/session.ts";
import { JsonlFramer, jsonlMapper } from "../sources/jsonl.ts";
import { killTree, launch as launchCommand } from "../verify/checks.ts";
import { piCommand } from "./pi-command.ts";
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

const AGENT_EXTENSION = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agent",
  "extension.ts",
);
// After a polite stop (stdin closed, then SIGTERM), wait this long before killing the tree.
export const KILL_GRACE_MS = 2000;
// An aborted child that has not settled after this long is stopped.
export const ABORT_BACKSTOP_MS = 5000;

export interface ProcessOptions {
  // The pi command (default: PINATA_PI, the parent's own Pi, or `pi` on PATH).
  command?: string[];
  // Extra environment for children (tests pass PI_CODING_AGENT_DIR).
  env?: NodeJS.ProcessEnv;
  webExtension?: string | null;
  // Called with each child's pid, for supervision and telemetry.
  onSpawn?: (task: string, pid: number) => void;
}

// 0.7.0's piArgs: an isolated child with only the agent's loadout.
export function piArgs(
  launch: AgentLaunch,
  files: { persona: string },
  sessionDir?: string,
): string[] {
  const web = launch.task.role === "research" ? launch.webExtension : undefined;
  return [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--provider",
    launch.model.provider,
    "--model",
    launch.model.id,
    "--thinking",
    launch.model.thinking ?? "off",
    "--tools",
    [...launch.tools, SUBMIT, ...(launch.codemode ? ["codemode"] : [])].join(","),
    ...(launch.codemode ? ["--extension", "builtin:codemode"] : []),
    ...(web ? ["--extension", web] : []),
    "--extension",
    AGENT_EXTENSION,
    "--append-system-prompt",
    files.persona,
    ...(sessionDir ? ["--session-dir", sessionDir] : ["--no-session"]),
  ];
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

// Stops a child and everything it started: stdin closed and SIGTERM to the group, then
// SIGKILL after the grace period (POSIX); taskkill /T /F (Windows).
export async function stopTree(child: ChildProcessWithoutNullStreams, graceMs = KILL_GRACE_MS) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdin.end();
  if (process.platform === "win32") {
    killTree(child.pid);
    await exited;
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  const timer = setTimeout(() => killTree(child.pid!), graceMs);
  await exited;
  clearTimeout(timer);
  // Grandchildren in the group (a stuck bash tool) go too.
  killTree(child.pid);
}

export class ProcessBackend implements AgentBackend {
  readonly kind = "process" as const;
  private readonly options: ProcessOptions;
  // Live children, for supervision (E6.4) and telemetry.
  readonly children = new Map<string, { pid: number; startedAt: number }>();

  constructor(options: ProcessOptions = {}) {
    this.options = options;
  }

  async start(
    launch: AgentLaunch,
    sink: (e: AgentEventInput) => void,
    signal: AbortSignal,
  ): Promise<AgentHandle> {
    const runDir = launch.transcript ? dirname(dirname(launch.transcript)) : undefined;
    const dir = runDir
      ? join(runDir, "agents", launch.task.id)
      : await mkdtemp(join(tmpdir(), "pinata-agent-"));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const persona = join(dir, "persona.md");
    const optionsFile = join(dir, "options.json");
    await writeFile(persona, launch.persona, { mode: 0o600 });
    await writeFile(optionsFile, JSON.stringify({ ...launch.agent, codemode: launch.codemode }), {
      mode: 0o600,
    });
    const sessionDir =
      launch.mode === "observe" && runDir ? join(runDir, "sessions", launch.task.id) : undefined;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      PINATA_AGENT: "1",
      PINATA_AGENT_OPTIONS_FILE: optionsFile,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    delete env.PINATA_AGENT_OPTIONS;
    const command = this.options.command ?? piCommand(env);
    const { file, args, verbatim } = launchCommand(
      [
        ...command,
        ...piArgs(
          {
            ...launch,
            webExtension: launch.webExtension ?? this.options.webExtension ?? undefined,
          },
          { persona },
          sessionDir,
        ),
      ],
      env,
    );
    const child = spawn(file, args, {
      cwd: launch.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so a cancel stops whatever its tools started.
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    }) as ChildProcessWithoutNullStreams;
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    this.children.set(`${launch.run}/${launch.task.id}`, {
      pid: child.pid!,
      startedAt: Date.now(),
    });
    this.options.onSpawn?.(launch.task.id, child.pid!);
    child.once("exit", () => this.children.delete(`${launch.run}/${launch.task.id}`));
    return attach(child, launch, sink, signal);
  }
}

function attach(
  child: ChildProcessWithoutNullStreams,
  launch: AgentLaunch,
  sink: (e: AgentEventInput) => void,
  signal: AbortSignal,
): AgentHandle {
  const mapper = jsonlMapper();
  const framer = new JsonlFramer();
  let usage: Usage = ZERO_USAGE;
  let result: AgentResult | null = null;
  let partial: any;
  let stderr = "";
  let exited: string | null = null;
  const inFlight = new Map<string, ToolRecord>();
  const live = launch.mode === "observe" && launch.transcript;
  let writes: Promise<void> = Promise.resolve();
  let nextId = 0;
  const pending = new Map<string, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  let settledWaiters: Array<() => void> = [];
  const send = (command: Record<string, unknown>) =>
    new Promise<any>((resolve, reject) => {
      if (exited) return reject(new Error(exited));
      const id = `pinata-${++nextId}`;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const record of framer.push(chunk)) {
      const r = record as any;
      if (r.type === "response") {
        const waiting = r.id ? pending.get(r.id) : undefined;
        if (waiting) {
          pending.delete(r.id);
          if (r.success === false) waiting.reject(new Error(r.error ?? `${r.command} failed`));
          else waiting.resolve(r.data);
        }
        continue;
      }
      // An abort that reached Pi before its run began was a no-op: abort again.
      if (aborting && (r.type === "agent_start" || r.type === "turn_start"))
        void send({ type: "abort" }).catch(() => {});
      if (r.type === "message_update") partial = r.message;
      if (r.type === "message_end") {
        partial = undefined;
        if (live)
          writes = writes.then(() => appendJsonl(launch.transcript!, r.message)).catch(() => {});
      }
      if (r.type === "tool_execution_start")
        inFlight.set(r.toolCallId, {
          call: r.toolCallId,
          name: r.toolName,
          args: argsPreview(r.toolName, r.args),
        });
      if (r.type === "tool_execution_end") {
        inFlight.delete(r.toolCallId);
        const submitted = r.result?.details?.pinataResult;
        if (r.toolName === SUBMIT && submitted && !r.isError) result = submitted as AgentResult;
      }
      for (const e of mapper.record(record)) {
        if (e.t === "message_end" && e.usage) usage = addUsage(usage, e.usage);
        sink(e);
      }
      if (r.type === "agent_settled") {
        const waiters = settledWaiters;
        settledWaiters = [];
        for (const w of waiters) w();
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
  child.on("exit", (code, sig) => {
    exited = `pi exited (${sig ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim().slice(-1000)}` : ""}`;
    for (const waiting of pending.values()) waiting.reject(new Error(exited));
    pending.clear();
    for (const w of settledWaiters) w();
    settledWaiters = [];
  });
  child.stdin.on("error", () => {});

  // Sends a prompt and waits until Pi has no automatic work left for it.
  const promptAndSettle = async (message: string) => {
    const settled = new Promise<void>((resolve) => settledWaiters.push(resolve));
    const data = await send({ type: "prompt", message });
    if (data?.disposition === "handled") return;
    await settled;
    if (exited) throw new Error(exited);
  };

  if (live)
    writes = appendJsonl(launch.transcript!, {
      role: "user",
      content: launch.brief,
      timestamp: Date.now(),
    }).catch(() => {});
  let aborting = false;
  const onAbort = () => {
    aborting = true;
    void send({ type: "abort" }).catch(() => {});
    // A child that does not settle soon after an abort is stopped.
    const backstop = setTimeout(() => void stopTree(child, 0), ABORT_BACKSTOP_MS);
    backstop.unref?.();
    void done.finally(() => clearTimeout(backstop));
  };
  const run = async (): Promise<AgentOutcome> => {
    let error: string | undefined;
    try {
      if (!signal.aborted) await promptAndSettle(launch.brief);
      const last = mapper.lastAssistant;
      // One reminder in the same session, as in process.
      if (
        !result &&
        !signal.aborted &&
        !exited &&
        last?.stopReason !== "error" &&
        last?.stopReason !== "aborted" &&
        mapper.turns < launch.budgets.maxTurns
      )
        await promptAndSettle(REMINDER);
    } catch (e) {
      error = (e as Error).message;
    }
    const last = mapper.lastAssistant;
    if (!error && last?.stopReason === "error") error = last.errorMessage ?? "provider error";
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
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  let disposed = false;
  return {
    done,
    async steer(text) {
      await send({ type: "steer", message: text });
    },
    async followUp(text) {
      await send({ type: "follow_up", message: text });
    },
    async abort() {
      await send({ type: "abort" }).catch(() => {});
    },
    async snapshot(): Promise<AgentSnapshot> {
      const data = await send({ type: "get_messages" });
      return {
        meta: {
          run: launch.run,
          agent: launch.task.id,
          role: launch.task.role,
          backend: "process",
        },
        status: "running",
        messages: data?.messages ?? [],
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
      if (launch.transcript && !live && !exited) {
        const data = await send({ type: "get_messages" }).catch(() => null);
        if (data?.messages) await writeJsonl(launch.transcript, data.messages).catch(() => {});
      }
      await writes;
      await stopTree(child);
    },
  };
}
