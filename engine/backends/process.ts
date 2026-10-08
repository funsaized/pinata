// The process backend: each agent is a `pi` child with 0.7.0's flags, the agent extension,
// and its persona, options and brief in files under <run>/agents/<task>/. Its JSON event
// stream maps to AgentEvents through the same mapper as in-process sessions; the result
// arrives in submit_result's tool result details (`pinataResult`).
//
// Attached agents (`pi --mode rpc`) are children of Pi on pipes. Detached agents (`survive`)
// run `pi --mode json` with stdin from the brief file and stdout appended to events.jsonl,
// the durable outbox; the host steers them through control.jsonl, which the agent extension
// follows (agent/detached.ts). The next Pi reattaches by reading the same files.
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REMINDER } from "../agent/brief.ts";
import { SUBMIT } from "../agent/extension.ts";
import { appendJsonl, writeJsonl } from "../core/store.ts";
import { ZERO_USAGE, addUsage } from "../core/types.ts";
import type { AgentEventInput, ToolRecord } from "../core/types.ts";
import { JsonlFramer, jsonlMapper } from "../sources/jsonl.ts";
import { readNew } from "../sources/log.ts";
import { argsPreview } from "../sources/session.ts";
import { launch as launchCommand } from "../verify/checks.ts";
import { piCommand } from "./pi-command.ts";
import { alive, identify, stopChild, stopIdentity, type ProcessIdentity } from "./supervise.ts";
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
// An aborted child that has not settled after this long is stopped.
export const ABORT_BACKSTOP_MS = 5000;
// How often a detached agent's events file is read, and its process checked.
export const TAIL_MS = 50;
export const ALIVE_MS = 2000;
// How long a steer waits for a detached agent to read it.
export const ACK_TIMEOUT_MS = 5000;

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
  mode: "rpc" | "json" = "rpc",
): string[] {
  const web = launch.task.role === "research" ? launch.webExtension : undefined;
  return [
    "--mode",
    mode,
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

// An agent's files: <run>/agents/<task>/ (a temporary directory outside a run).
async function agentFiles(launch: AgentLaunch) {
  const runDir = launch.transcript ? dirname(dirname(launch.transcript)) : undefined;
  const dir = runDir
    ? join(runDir, "agents", launch.task.id)
    : await mkdtemp(join(tmpdir(), "pinata-agent-"));
  return {
    runDir,
    dir,
    persona: join(dir, "persona.md"),
    options: join(dir, "options.json"),
    brief: join(dir, "brief.md"),
    events: join(dir, "events.jsonl"),
    stderr: join(dir, "stderr.log"),
    control: join(dir, "control.jsonl"),
    pid: join(dir, "pid.json"),
    consumed: join(dir, "consumed.json"),
  };
}
type AgentFiles = Awaited<ReturnType<typeof agentFiles>>;

// What an agent's event records add up to: events for the sink, usage, the submitted
// result, the streaming partial, tools in flight and (for detached agents) its messages.
class Records {
  readonly mapper = jsonlMapper();
  usage: Usage = ZERO_USAGE;
  result: AgentResult | null = null;
  partial: any;
  readonly inFlight = new Map<string, ToolRecord>();
  readonly messages: unknown[] = [];
  settled = 0;
  private readonly sink: (e: AgentEventInput) => void;
  private readonly onMessage?: (message: unknown) => void;

  constructor(sink: (e: AgentEventInput) => void, onMessage?: (message: unknown) => void) {
    this.sink = sink;
    this.onMessage = onMessage;
  }

  // `emit` is false for records an earlier Pi already reported.
  push(record: any, emit = true): void {
    if (record.type === "message_update") this.partial = record.message;
    if (record.type === "message_end") {
      this.partial = undefined;
      this.messages.push(record.message);
      if (emit) this.onMessage?.(record.message);
    }
    if (record.type === "tool_execution_start")
      this.inFlight.set(record.toolCallId, {
        call: record.toolCallId,
        name: record.toolName,
        args: argsPreview(record.toolName, record.args),
      });
    if (record.type === "tool_execution_end") {
      this.inFlight.delete(record.toolCallId);
      const submitted = record.result?.details?.pinataResult;
      if (record.toolName === SUBMIT && submitted && !record.isError)
        this.result = submitted as AgentResult;
    }
    for (const e of this.mapper.record(record)) {
      if (e.t === "message_end" && e.usage) this.usage = addUsage(this.usage, e.usage);
      if (emit) this.sink(e);
    }
    if (record.type === "agent_settled") this.settled++;
  }

  outcome(signal: AbortSignal, error?: string): AgentOutcome {
    const last = this.mapper.lastAssistant;
    if (!error && last?.stopReason === "error") error = last.errorMessage ?? "provider error";
    const stopReason: StopReason = this.result
      ? "submitted"
      : signal.aborted
        ? "aborted"
        : error
          ? "error"
          : "no_result";
    return {
      result: this.result,
      stopReason,
      ...(stopReason === "error" && { error }),
      ...(stopReason === "no_result" && {
        error: "The agent finished without calling submit_result",
      }),
      usage: this.usage,
      turns: this.mapper.turns,
      toolCalls: this.mapper.toolCalls,
      ...(last && { model: { provider: last.provider, id: last.model } }),
    };
  }

  snapshot(launch: AgentLaunch, messages: unknown[]): AgentSnapshot {
    return {
      meta: { run: launch.run, agent: launch.task.id, role: launch.task.role, backend: "process" },
      status: "running",
      messages,
      ...(this.partial && { streaming: partialText(this.partial) }),
      toolsInFlight: [...this.inFlight.values()],
      usage: this.usage,
      counters: { turns: this.mapper.turns, toolCalls: this.mapper.toolCalls },
    };
  }
}

export class ProcessBackend implements AgentBackend {
  readonly kind = "process" as const;
  private readonly options: ProcessOptions;
  // Live children, for supervision (E6.4) and telemetry.
  readonly children = new Map<string, { pid: number; startedAt: number }>();

  constructor(options: ProcessOptions = {}) {
    this.options = options;
  }

  private env(files: AgentFiles): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      PINATA_AGENT: "1",
      PINATA_AGENT_OPTIONS_FILE: files.options,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    delete env.PINATA_AGENT_OPTIONS;
    return env;
  }

  private track(launch: AgentLaunch, child: ChildProcess): void {
    const key = `${launch.run}/${launch.task.id}`;
    this.children.set(key, { pid: child.pid!, startedAt: Date.now() });
    this.options.onSpawn?.(launch.task.id, child.pid!);
    child.once("exit", () => this.children.delete(key));
  }

  async start(
    launch: AgentLaunch,
    sink: (e: AgentEventInput) => void,
    signal: AbortSignal,
  ): Promise<AgentHandle> {
    const files = await agentFiles(launch);
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    const web = launch.webExtension ?? this.options.webExtension ?? undefined;
    const full = { ...launch, ...(web && { webExtension: web }) };
    await writeFile(files.persona, launch.persona, { mode: 0o600 });
    const sessionDir =
      launch.mode === "observe" && files.runDir
        ? join(files.runDir, "sessions", launch.task.id)
        : undefined;
    const env = this.env(files);
    const command = this.options.command ?? piCommand(env);
    if (launch.detached)
      return this.startDetached(launch, full, files, env, command, sessionDir, sink, signal);
    await writeFile(files.options, JSON.stringify({ ...launch.agent, codemode: launch.codemode }), {
      mode: 0o600,
    });
    const { file, args, verbatim } = launchCommand(
      [...command, ...piArgs(full, files, sessionDir)],
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
    this.track(launch, child);
    return attach(child, launch, sink, signal);
  }

  private async startDetached(
    launch: AgentLaunch,
    full: AgentLaunch,
    files: AgentFiles,
    env: NodeJS.ProcessEnv,
    command: string[],
    sessionDir: string | undefined,
    sink: (e: AgentEventInput) => void,
    signal: AbortSignal,
  ): Promise<AgentHandle> {
    await writeFile(
      files.options,
      JSON.stringify({
        ...launch.agent,
        codemode: launch.codemode,
        detached: { control: files.control, remind: true, budgets: launch.budgets },
      }),
      { mode: 0o600 },
    );
    await writeFile(files.brief, launch.brief, { mode: 0o600 });
    await writeFile(files.control, "", { mode: 0o600 });
    const { file, args, verbatim } = launchCommand(
      [...command, ...piArgs(full, files, sessionDir, "json")],
      env,
    );
    // Stdin is the brief (Pi's first prompt), stdout the events file: no pipes to Pi.
    const fds = [
      openSync(files.brief, "r"),
      openSync(files.events, "a", 0o600),
      openSync(files.stderr, "a", 0o600),
    ];
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: launch.cwd,
        env,
        stdio: fds,
        detached: true,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
    } finally {
      for (const fd of fds) closeSync(fd);
    }
    child.unref();
    this.track(launch, child);
    const identity = (await identify(child.pid!)) ?? { pid: child.pid!, started: "" };
    await writeFile(files.pid, JSON.stringify(identity), { mode: 0o600 });
    return followDetached(files, identity, launch, sink, signal, child, 0);
  }

  async reattach(
    launch: AgentLaunch,
    sink: (e: AgentEventInput) => void,
    signal: AbortSignal,
  ): Promise<AgentHandle | null> {
    const files = await agentFiles(launch);
    const identity = await readFile(files.pid, "utf8")
      .then((raw) => JSON.parse(raw) as ProcessIdentity)
      .catch(() => null);
    if (!identity) return null;
    const consumed = await readFile(files.consumed, "utf8")
      .then((raw) => Number(JSON.parse(raw).records) || 0)
      .catch(() => 0);
    return followDetached(files, identity, launch, sink, signal, undefined, consumed);
  }
}

// Follows a detached agent through its files. `skip` records were already reported by the
// Pi that started it.
function followDetached(
  files: AgentFiles,
  identity: ProcessIdentity,
  launch: AgentLaunch,
  sink: (e: AgentEventInput) => void,
  signal: AbortSignal,
  child: ChildProcess | undefined,
  skip: number,
): AgentHandle {
  const live = launch.mode === "observe" && launch.transcript;
  let writes: Promise<void> = Promise.resolve();
  const records = new Records(sink, (message) => {
    if (live) writes = writes.then(() => appendJsonl(launch.transcript!, message)).catch(() => {});
  });
  const framer = new JsonlFramer();
  let offset = 0;
  let count = 0;
  let stopped = false;
  let exited = child ? false : undefined;
  child?.once("exit", () => (exited = true));
  let lastCheck = 0;
  let finish!: (error?: string) => void;
  const finished = new Promise<string | undefined>((resolve) => (finish = resolve));

  // Reads new records; serialized, so the tail loop and snapshots never read twice.
  let reading: Promise<void> = Promise.resolve();
  const read = () =>
    (reading = reading.then(async () => {
      const next = await readNew(files.events, offset).catch(() => ({ lines: [], offset }));
      offset = next.offset;
      for (const record of framer.push(next.lines.map((l) => l + "\n").join(""))) {
        count++;
        records.push(record, count > skip);
      }
    }));
  const tail = async () => {
    while (!stopped) {
      await read();
      if (records.settled) return finish();
      // Gone without settling: read once more, then report it.
      const now = Date.now();
      if (exited === true || (exited === undefined && now - lastCheck >= ALIVE_MS)) {
        lastCheck = now;
        if (exited === true || !(await alive(identity))) {
          await read();
          if (records.settled) return finish();
          const stderr = (await readFile(files.stderr, "utf8").catch(() => "")).trim();
          return finish(
            `The agent process ended without settling${stderr ? `: ${stderr.slice(-1000)}` : ""}`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, TAIL_MS));
    }
  };
  void tail();
  const command = (value: Record<string, unknown>) =>
    appendFile(files.control, JSON.stringify(value) + "\n", { mode: 0o600 });
  // Steering returns once the agent has read the command (it acknowledges by offset).
  const delivered = async (value: Record<string, unknown>) => {
    await command(value);
    const size = (await stat(files.control)).size;
    const end = Date.now() + ACK_TIMEOUT_MS;
    while (Date.now() < end && !records.settled) {
      const ack = Number(await readFile(`${files.control}.ack`, "utf8").catch(() => "0"));
      if (ack >= size) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!records.settled) throw new Error("The detached agent did not take the message in time");
  };
  let aborting = false;
  const onAbort = () => {
    if (aborting) return;
    aborting = true;
    void command({ type: "abort" }).catch(() => {});
    const backstop = setTimeout(() => {
      void (child ? stopChild(child, 0) : stopIdentity(identity, 0));
    }, ABORT_BACKSTOP_MS);
    backstop.unref?.();
    void finished.finally(() => clearTimeout(backstop));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const done = finished.then((error) => records.outcome(signal, error));
  let disposed = false;
  return {
    done,
    async steer(text) {
      await delivered({ type: "steer", message: text });
    },
    async followUp(text) {
      await delivered({ type: "follow_up", message: text });
    },
    async abort() {
      onAbort();
    },
    async snapshot() {
      await read();
      return records.snapshot(launch, [...records.messages]);
    },
    async detach() {
      stopped = true;
      signal.removeEventListener("abort", onAbort);
      await writeFile(files.consumed, JSON.stringify({ records: count }), { mode: 0o600 });
      await writes;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      stopped = true;
      signal.removeEventListener("abort", onAbort);
      if (launch.transcript && !live)
        await writeJsonl(launch.transcript, records.messages).catch(() => {});
      await writes;
      if (child) await stopChild(child);
      else await stopIdentity(identity);
    },
  };
}

// An attached `pi --mode rpc` child on pipes.
function attach(
  child: ChildProcessWithoutNullStreams,
  launch: AgentLaunch,
  sink: (e: AgentEventInput) => void,
  signal: AbortSignal,
): AgentHandle {
  const live = launch.mode === "observe" && launch.transcript;
  let writes: Promise<void> = Promise.resolve();
  const records = new Records(sink, (message) => {
    if (live) writes = writes.then(() => appendJsonl(launch.transcript!, message)).catch(() => {});
  });
  const framer = new JsonlFramer();
  let stderr = "";
  let exited: string | null = null;
  let nextId = 0;
  let aborting = false;
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
      records.push(r);
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

  const run = async (): Promise<AgentOutcome> => {
    let error: string | undefined;
    try {
      if (!signal.aborted) await promptAndSettle(launch.brief);
      const last = records.mapper.lastAssistant;
      // One reminder in the same session, as in process.
      if (
        !records.result &&
        !signal.aborted &&
        !exited &&
        last?.stopReason !== "error" &&
        last?.stopReason !== "aborted" &&
        records.mapper.turns < launch.budgets.maxTurns
      )
        await promptAndSettle(REMINDER);
    } catch (e) {
      error = (e as Error).message;
    }
    return records.outcome(signal, error);
  };
  const done = run();
  const onAbort = () => {
    aborting = true;
    void send({ type: "abort" }).catch(() => {});
    // A child that does not settle soon after an abort is stopped.
    const backstop = setTimeout(() => void stopChild(child, 0), ABORT_BACKSTOP_MS);
    backstop.unref?.();
    void done.finally(() => clearTimeout(backstop));
  };
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
      return records.snapshot(launch, data?.messages ?? []);
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
      await stopChild(child);
    },
  };
}
