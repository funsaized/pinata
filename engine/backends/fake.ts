// A scripted backend for engine tests and benchmarks: per task latency, events, a result or an
// error. It never calls a model.
import { ZERO_USAGE, addUsage } from "../core/types.ts";
import type {
  AgentBackend,
  AgentEventInput,
  AgentHandle,
  AgentLaunch,
  AgentOutcome,
  AgentResult,
  AgentSnapshot,
  Usage,
} from "./types.ts";

export interface FakeScript {
  // Delay before the first event.
  latencyMs?: number;
  // Delay between scripted events.
  stepMs?: number;
  // Defaults to one turn with one tool call and an assistant message.
  events?: AgentEventInput[];
  result?: AgentResult | null;
  // Fail the agent loop with this error.
  error?: string;
  // Keep running until aborted.
  hang?: boolean;
  usage?: Partial<Usage>;
}

export function fakeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    status: "succeeded",
    summary: "Fake result",
    changedFiles: [],
    checks: [],
    findings: [],
    blockers: [],
    brief: "Fake brief",
    ...overrides,
  };
}

const defaultEvents = (usage: Partial<Usage>): AgentEventInput[] => [
  { t: "turn_start", turn: 1 },
  { t: "tool_start", call: "c1", name: "read", args: "README.md" },
  { t: "tool_end", call: "c1", ok: true, preview: "# Fixture", ms: 1 },
  { t: "text_delta", delta: "Done." },
  { t: "message_end", role: "assistant", usage: { ...ZERO_USAGE, ...usage }, stopReason: "stop" },
];

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export interface FakeStart {
  task: string;
  at: number; // performance.now()
  launch: AgentLaunch;
}

export class FakeBackend implements AgentBackend {
  readonly kind = "fake" as const;
  readonly starts: FakeStart[] = [];
  readonly steers: Array<{ task: string; text: string; as: "steer" | "followUp" }> = [];
  private readonly script: (launch: AgentLaunch) => FakeScript;

  constructor(script: Record<string, FakeScript> | ((launch: AgentLaunch) => FakeScript) = {}) {
    this.script = typeof script === "function" ? script : (launch) => script[launch.task.id] ?? {};
  }

  async start(
    launch: AgentLaunch,
    sink: (e: AgentEventInput) => void,
    signal: AbortSignal,
  ): Promise<AgentHandle> {
    this.starts.push({ task: launch.task.id, at: performance.now(), launch });
    const script = this.script(launch);
    const local = new AbortController();
    const stop = AbortSignal.any([signal, local.signal]);
    let usage: Usage = ZERO_USAGE;
    let turns = 0;
    let toolCalls = 0;
    const messages: unknown[] = [{ role: "user", content: launch.brief }];
    const run = async (): Promise<AgentOutcome> => {
      await sleep(script.latencyMs ?? 0, stop);
      for (const event of script.events ?? defaultEvents(script.usage ?? {})) {
        if (stop.aborted) break;
        if (event.t === "turn_start") turns++;
        if (event.t === "tool_start") toolCalls++;
        if (event.t === "message_end") usage = addUsage(usage, event.usage);
        sink(event);
        await sleep(script.stepMs ?? 0, stop);
      }
      if (script.hang && !stop.aborted)
        await new Promise<void>((resolve) =>
          stop.addEventListener("abort", () => resolve(), { once: true }),
        );
      const base = {
        usage,
        turns,
        toolCalls,
        messages,
        model: { provider: launch.model.provider, id: launch.model.id },
      };
      if (stop.aborted)
        return {
          ...base,
          result: null,
          stopReason: "aborted",
          error: String(stop.reason ?? "aborted"),
        };
      if (script.error) return { ...base, result: null, stopReason: "error", error: script.error };
      const result = script.result === undefined ? fakeResult() : script.result;
      return result
        ? { ...base, result, stopReason: "submitted" }
        : { ...base, result: null, stopReason: "no_result" };
    };
    const done = run();
    const steers = this.steers;
    return {
      done,
      async steer(text) {
        steers.push({ task: launch.task.id, text, as: "steer" });
      },
      async followUp(text) {
        steers.push({ task: launch.task.id, text, as: "followUp" });
      },
      async abort() {
        local.abort("aborted");
        await done;
      },
      async snapshot(): Promise<AgentSnapshot> {
        return {
          meta: { run: launch.run, agent: launch.task.id, role: launch.task.role, backend: "fake" },
          status: "running",
          messages,
          toolsInFlight: [],
          usage,
          counters: { turns, toolCalls },
        };
      },
      async dispose() {
        local.abort("disposed");
      },
    };
  }
}
