// The view model: one pure reducer that every surface consumes (widget, detail view, viewer,
// headless reporter, /pinata text). Throttling happens per consumer, not here.
import {
  ZERO_USAGE,
  addUsage,
  type AgentEvent,
  type AgentStatus,
  type BackendKind,
  type ModelRef,
  type Mode,
  type Role,
  type RunStatus,
  type TaskSpec,
  type ToolRecord,
  type Usage,
  type WorkspaceRef,
} from "./types.ts";

export const RECENT_TOOLS = 20;
// The streaming tail kept for activity previews; the transcript keeps the full text.
export const STREAM_TAIL = 400;

export interface CheckView {
  state: "running" | "passed" | "failed";
  ms?: number;
}

export interface AgentView {
  id: string;
  role: Role;
  status: "queued" | "running" | AgentStatus;
  backend?: BackendKind | "fake";
  model?: ModelRef;
  workspace?: WorkspaceRef;
  queuedAt?: number;
  startedAt?: number;
  settledAt?: number;
  turns: number;
  toolCalls: number;
  usage: Usage;
  // What the agent is doing now: "thinking", "writing", a tool with its args, or null.
  activity: string | null;
  streaming: { text: string; thinking: string } | null;
  toolsInFlight: ToolRecord[];
  recentTools: ToolRecord[];
  checks: Record<string, CheckView>;
  steers: Array<{ by: "user" | "parent"; text: string; as: "steer" | "followUp"; at: number }>;
  checkoutChanged: boolean;
  summary?: string;
  reason?: string;
}

export interface RunView {
  run: string;
  mode: Mode;
  status: "running" | RunStatus;
  seq: number;
  startedAt: number;
  settledAt?: number;
  tasks: TaskSpec[];
  order: string[];
  agents: Record<string, AgentView>;
  usage: Usage;
}

function agentView(task: TaskSpec, at: number): AgentView {
  return {
    id: task.id,
    role: task.role,
    status: "queued",
    queuedAt: at,
    turns: 0,
    toolCalls: 0,
    usage: ZERO_USAGE,
    activity: null,
    streaming: null,
    toolsInFlight: [],
    recentTools: [],
    checks: {},
    steers: [],
    checkoutChanged: false,
  };
}

export function emptyView(run: string): RunView {
  return {
    run,
    mode: "lean",
    status: "running",
    seq: -1,
    startedAt: 0,
    tasks: [],
    order: [],
    agents: {},
    usage: ZERO_USAGE,
  };
}

// The initial view for a late-joining consumer. Snapshots are plain JSON.
export function fromSnapshot(snapshot: RunView): RunView {
  return structuredClone(snapshot);
}

function totalUsage(agents: Record<string, AgentView>): Usage {
  let usage = ZERO_USAGE;
  for (const agent of Object.values(agents)) usage = addUsage(usage, agent.usage);
  return usage;
}

function tail(text: string, delta: string) {
  const next = text + delta;
  return next.length > STREAM_TAIL ? next.slice(next.length - STREAM_TAIL) : next;
}

function toolActivity(tool: ToolRecord) {
  return tool.args ? `${tool.name} ${tool.args}` : tool.name;
}

function updateAgent(view: RunView, id: string, change: (agent: AgentView) => AgentView): RunView {
  const agent = view.agents[id];
  if (!agent) return view;
  return { ...view, agents: { ...view.agents, [id]: change(agent) } };
}

// Applies one event. Events at or below the view's seq were already applied and are ignored,
// so a snapshot followed by the events after it equals a full replay.
export function reduce(view: RunView, event: AgentEvent): RunView {
  if (event.seq <= view.seq) return view;
  const next = apply(view, event);
  return next === view ? { ...view, seq: event.seq } : { ...next, seq: event.seq };
}

function apply(view: RunView, e: AgentEvent): RunView {
  const id = e.agent;
  switch (e.t) {
    case "run_started": {
      const agents: Record<string, AgentView> = {};
      for (const task of e.tasks) agents[task.id] = agentView(task, e.at);
      return {
        ...view,
        run: e.run,
        mode: e.mode,
        status: "running",
        startedAt: e.at,
        tasks: e.tasks,
        order: e.tasks.map((t) => t.id),
        agents,
        usage: ZERO_USAGE,
      };
    }
    case "agent_queued": {
      if (!id) return view;
      const existing = view.agents[id];
      if (e.task && !existing)
        return {
          ...view,
          tasks: [...view.tasks, e.task],
          order: [...view.order, id],
          agents: { ...view.agents, [id]: agentView(e.task, e.at) },
        };
      if (!existing) return view;
      // A requeued agent (repair) starts over, keeping its spend.
      const fresh = agentView(
        e.task ?? { id, role: existing.role, task: "", acceptance: [] },
        e.at,
      );
      return {
        ...view,
        tasks: e.task ? view.tasks.map((t) => (t.id === id ? e.task! : t)) : view.tasks,
        agents: {
          ...view.agents,
          [id]: { ...fresh, usage: existing.usage, steers: existing.steers },
        },
      };
    }
    case "agent_started":
      return updateAgent(view, id!, (a) => ({
        ...a,
        status: "running",
        backend: e.backend,
        model: e.model,
        workspace: e.workspace,
        startedAt: e.at,
        activity: "starting",
      }));
    case "turn_start":
      return updateAgent(view, id!, (a) => ({
        ...a,
        turns: Math.max(a.turns, e.turn),
        activity: "thinking",
      }));
    case "text_delta":
      return updateAgent(view, id!, (a) => ({
        ...a,
        activity: a.toolsInFlight.length ? a.activity : "writing",
        streaming: {
          text: tail(a.streaming?.text ?? "", e.delta),
          thinking: a.streaming?.thinking ?? "",
        },
      }));
    case "thinking_delta":
      return updateAgent(view, id!, (a) => ({
        ...a,
        activity: a.toolsInFlight.length ? a.activity : "thinking",
        streaming: {
          text: a.streaming?.text ?? "",
          thinking: tail(a.streaming?.thinking ?? "", e.delta),
        },
      }));
    case "message_end":
      return e.role === "assistant"
        ? updateAgent(view, id!, (a) => ({ ...a, streaming: null }))
        : view;
    case "tool_start":
      return updateAgent(view, id!, (a) => {
        const tool: ToolRecord = { call: e.call, name: e.name, args: e.args };
        return {
          ...a,
          toolCalls: a.toolCalls + 1,
          activity: toolActivity(tool),
          toolsInFlight: [...a.toolsInFlight, tool],
        };
      });
    case "tool_update":
      return updateAgent(view, id!, (a) => ({
        ...a,
        toolsInFlight: a.toolsInFlight.map((t) =>
          t.call === e.call ? { ...t, preview: e.preview } : t,
        ),
      }));
    case "tool_end":
      return updateAgent(view, id!, (a) => {
        const started = a.toolsInFlight.find((t) => t.call === e.call);
        const inFlight = a.toolsInFlight.filter((t) => t.call !== e.call);
        const done: ToolRecord = {
          call: e.call,
          name: started?.name ?? "tool",
          args: started?.args ?? "",
          ok: e.ok,
          preview: e.preview,
          ms: e.ms,
        };
        return {
          ...a,
          toolsInFlight: inFlight,
          recentTools: [...a.recentTools, done].slice(-RECENT_TOOLS),
          activity: inFlight.length ? toolActivity(inFlight.at(-1)!) : "thinking",
        };
      });
    case "steer":
      return updateAgent(view, id!, (a) => ({
        ...a,
        steers: [...a.steers, { by: e.by, text: e.text, as: e.as, at: e.at }],
      }));
    case "retry":
      return updateAgent(view, id!, (a) => ({
        ...a,
        activity: `retrying (attempt ${e.attempt}): ${e.reason}`,
      }));
    case "check_start":
      return updateAgent(view, id!, (a) => ({
        ...a,
        activity: `check ${e.check}`,
        checks: { ...a.checks, [e.check]: { state: "running" } },
      }));
    case "check_end":
      return updateAgent(view, id!, (a) => ({
        ...a,
        checks: { ...a.checks, [e.check]: { state: e.passed ? "passed" : "failed", ms: e.ms } },
      }));
    case "checkout_changed":
      return updateAgent(view, id!, (a) => ({ ...a, checkoutChanged: true }));
    case "usage": {
      const next = updateAgent(view, id!, (a) => ({ ...a, usage: e.usage }));
      return { ...next, usage: totalUsage(next.agents) };
    }
    case "agent_settled": {
      const next = updateAgent(view, id!, (a) => ({
        ...a,
        status: e.status,
        settledAt: e.at,
        summary: e.summary,
        ...(e.reason !== undefined && { reason: e.reason }),
        usage: e.usage,
        turns: e.turns,
        toolCalls: e.toolCalls,
        activity: null,
        streaming: null,
        toolsInFlight: [],
        recentTools: [],
      }));
      return { ...next, usage: totalUsage(next.agents) };
    }
    case "run_settled":
      return { ...view, status: e.status, settledAt: e.at, usage: e.usage };
  }
}

export function replayView(events: Iterable<AgentEvent>, run = ""): RunView {
  let view = emptyView(run);
  for (const event of events) view = reduce(view, event);
  return view;
}

// Batches events for one consumer: at most one delivery per interval, and adjacent text
// deltas of the same agent merged. No timer runs while nothing is pending.
export function coalesce(
  deliver: (events: AgentEvent[]) => void,
  intervalMs: number,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = {
    set: setTimeout,
    clear: clearTimeout,
  },
) {
  let pending: AgentEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = -Infinity;
  const flush = () => {
    timer = undefined;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    last = performance.now();
    deliver(batch);
  };
  return {
    push(event: AgentEvent) {
      const prev = pending.at(-1);
      if (
        prev &&
        (event.t === "text_delta" || event.t === "thinking_delta") &&
        prev.t === event.t &&
        prev.agent === event.agent
      )
        pending[pending.length - 1] = {
          ...prev,
          delta: prev.delta + event.delta,
          seq: event.seq,
          at: event.at,
        };
      else pending.push(event);
      if (timer) return;
      const wait = Math.max(0, last + intervalMs - performance.now());
      timer = timers.set(flush, wait);
      (timer as { unref?: () => void }).unref?.();
    },
    flush() {
      if (timer) timers.clear(timer);
      flush();
    },
    get pending() {
      return pending.length;
    },
  };
}
