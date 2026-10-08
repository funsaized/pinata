// Engine contracts. ENGINE_PLAN.md "Contracts" sketches them; this file is the source of truth.
// Nothing under engine/core imports Pi.

export const ROLES = ["scout", "research", "planner", "builder", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelRef {
  provider: string;
  id: string;
  thinking: ThinkingLevel;
}

export const BACKENDS = ["in-process", "process", "herdr-pi"] as const;
export type BackendKind = (typeof BACKENDS)[number];

export type Mode = "lean" | "observe";

export interface Check {
  id: string;
  argv: string[];
  timeoutMs?: number;
}

export interface TaskSpec {
  id: string; // ^[a-z][a-z0-9-]{0,31}$
  role: Role;
  task: string;
  acceptance: string[];
  instructions?: string[];
  context?: string[];
  after?: string[]; // dependencies; their results are inlined into this task's first message
  ownership?: string[]; // builders only: repo-relative files or directory prefixes
  checks?: Check[]; // builders only
  evidenceChecks?: Check[]; // any role: non-mutating commands for consequential claims
  noChecksReason?: string;
  reviewOf?: string; // reviewer of a builder task
  reviewBase?: string; // reviewer of the live checkout against a revision
  reviewPr?: number; // reviewer of a GitHub pull request
  model?: ModelRef;
  backend?: BackendKind; // override; default in-process
}

// A task after validation: optional lists are present.
export interface Task extends TaskSpec {
  after: string[];
  ownership: string[];
  instructions: string[];
  context: string[];
  checks: Check[];
  evidenceChecks: Check[];
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export const AGENT_STATUSES = [
  "succeeded",
  "failed",
  "rejected",
  "blocked",
  "cancelled",
  "uncertain",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type RunStatus = "succeeded" | "failed" | "cancelled";

// Where a failure happened, as in 0.7.0's outcome.failureStage.
export type FailureStage = "workspace" | "launch" | "process" | "result" | "verification";

export interface WorkspaceRef {
  kind: "live" | "worktree";
  path: string;
}

// Events (schema v1). Every event carries the envelope; `seq` increases per run.
export interface Envelope {
  v: 1;
  seq: number;
  run: string;
  agent?: string;
  at: number;
}

export interface ToolRecord {
  call: string;
  name: string;
  args: string;
  ok?: boolean;
  preview?: string;
  ms?: number;
}

export type EventBody =
  | { t: "run_started"; tasks: TaskSpec[]; mode: Mode }
  | { t: "agent_queued"; task?: TaskSpec } // task: added or requeued after run_started
  | { t: "agent_started"; backend: BackendKind | "fake"; model: ModelRef; workspace: WorkspaceRef }
  | { t: "turn_start"; turn: number }
  | { t: "text_delta" | "thinking_delta"; delta: string }
  | {
      t: "message_end";
      role: "assistant" | "user" | "toolResult";
      usage?: Usage;
      stopReason?: string;
      error?: string;
    }
  | { t: "tool_start"; call: string; name: string; args: string } // args: truncated preview
  | { t: "tool_update"; call: string; preview: string }
  | { t: "tool_end"; call: string; ok: boolean; preview: string; ms: number }
  | { t: "steer"; by: "user" | "parent"; text: string; as: "steer" | "followUp" }
  | { t: "retry"; attempt: number; reason: string }
  | { t: "check_start"; check: string }
  | { t: "check_end"; check: string; passed: boolean; ms: number }
  | { t: "checkout_changed" } // a live-checkout reader saw the checkout change mid-run
  | { t: "usage"; usage: Usage } // lean-mode usage tick: the agent's cumulative usage
  | {
      t: "agent_settled";
      status: AgentStatus;
      summary: string;
      reason?: string;
      usage: Usage;
      turns: number;
      toolCalls: number;
    }
  | { t: "run_settled"; status: RunStatus; usage: Usage }
  | { t: "run_resumed"; reason: string }; // a settled run reopened (a repair)

export type AgentEvent = Envelope & EventBody;
export type EventType = EventBody["t"];

// What a backend emits; the engine adds the envelope.
export type AgentEventInput = EventBody;

// Results submitted through `submit_result`.
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export interface Finding {
  severity: Severity;
  message: string;
  evidence: string;
}
export interface ReportedCheck {
  name: string;
  status: "passed" | "failed" | "not-run";
  detail: string;
}
export interface Source {
  url: string;
  title: string;
  supports: string;
  applicability: string;
}
export interface Review {
  taskId: string | null;
  fingerprint: string;
  verdict: "approve" | "changes_requested";
}
export interface AgentResult {
  status: "succeeded" | "failed" | "blocked" | "cancelled";
  summary: string;
  changedFiles: string[];
  checks: ReportedCheck[];
  findings: Finding[];
  blockers: string[];
  brief?: string;
  sources?: Source[];
  review?: Review;
  // Set by the engine: a live-checkout reader saw the checkout change mid-run.
  checkoutChanged?: boolean;
}

// How a backend's agent loop ended.
export type StopReason = "submitted" | "no_result" | "aborted" | "error";

export interface AgentOutcome {
  result: AgentResult | null;
  stopReason: StopReason;
  error?: string;
  usage: Usage;
  turns: number;
  toolCalls: number;
  // The model that actually answered, from the last assistant message.
  model?: { provider: string; id: string };
  // Pi AgentMessage values, kept by the backend until dispose.
  messages?: unknown[];
}

export interface AgentCounters {
  turns: number;
  toolCalls: number;
}

export interface AgentSnapshot {
  meta: { run: string; agent: string; role: Role; backend: BackendKind | "fake" };
  status: "running" | AgentStatus;
  messages: unknown[]; // Pi AgentMessage shape
  streaming?: { text: string; thinking: string };
  toolsInFlight: ToolRecord[];
  usage: Usage;
  counters: AgentCounters;
}

export interface Budgets {
  // Absolute epoch deadline for the agent's loop.
  deadline: number;
  maxTurns: number;
  maxToolCalls: number;
  maxCostUsd?: number;
}

// Options for the agent extension that runs inside every agent.
export interface AgentOptions {
  run: string;
  task: string;
  role: Role;
  tools: string[];
  // Builders: repo-relative ownership and the worktree root edits must stay in.
  ownership: string[];
  writeRoot?: string;
  readOnly: boolean;
  caseInsensitive?: boolean;
  // Facts the result must echo back, such as a reviewer's target.
  reviewTarget?: { taskId: string | null; fingerprint: string };
}

export interface AgentLaunch {
  run: string;
  task: Task;
  model: ModelRef;
  cwd: string;
  tools: string[];
  persona: string; // appended to the system prompt; identical for siblings of a role
  brief: string; // the first user message
  budgets: Budgets;
  agent: AgentOptions;
  mode: Mode;
  codemode: boolean;
  // Where the transcript is written (lean: at settle; observe: live).
  transcript?: string;
  // Repair feedback or a result-only retry.
  resultOnly?: boolean;
  // The repository root (the run's cwd), and pi-web-access for research agents.
  root?: string;
  webExtension?: string;
}

export interface AgentHandle {
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  snapshot(): Promise<AgentSnapshot>;
  readonly done: Promise<AgentOutcome>;
  dispose(): Promise<void>;
}

export interface AgentBackend {
  readonly kind: BackendKind | "fake";
  start(
    launch: AgentLaunch,
    sink: (e: AgentEventInput) => void,
    signal: AbortSignal,
  ): Promise<AgentHandle>;
}

export interface ChangeSet {
  base: string; // base tree id
  tree: string; // result tree id
  changes: Array<{
    path: string;
    status: "A" | "M" | "D" | "T";
    oldMode: string;
    newMode: string;
    oldBlob: string;
    newBlob: string;
  }>;
}

export interface Workspace {
  readonly kind: "live" | "worktree";
  readonly path: string;
  fingerprint(): Promise<string>; // live: HEAD + hash of `git status --porcelain=v2 -z`
  capture?(): Promise<ChangeSet>; // worktree: tree-based change capture
  dispose(): Promise<void>;
}

export interface Clock {
  now(): number; // epoch milliseconds
}

export const ZERO_USAGE: Usage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
});

export function addUsage(a: Usage, b: Partial<Usage> | undefined): Usage {
  if (!b) return a;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    input: a.input + n(b.input),
    output: a.output + n(b.output),
    cacheRead: a.cacheRead + n(b.cacheRead),
    cacheWrite: a.cacheWrite + n(b.cacheWrite),
    totalTokens: a.totalTokens + n(b.totalTokens),
    cost: Math.round((a.cost + n(b.cost)) * 1e9) / 1e9,
  };
}

// 0.7.0's limits (lib/core.mjs LIMITS), plus the engine's global concurrency cap.
export const LIMITS = {
  concurrency: 16,
  taskMs: 1_200_000,
  jobMs: 5_400_000,
  repairs: 2,
  maxTurns: 60,
  maxToolCalls: 400,
};
export const LIMIT_MAX = {
  concurrency: 64,
  taskMs: 86_400_000,
  jobMs: 86_400_000,
  repairs: 10,
  maxTurns: 1000,
  maxToolCalls: 10_000,
};
export const COST_MAX = 10_000;
export interface Limits {
  concurrency: number;
  taskMs: number;
  jobMs: number;
  repairs: number;
  maxTurns: number;
  maxToolCalls: number;
  costUsd?: number;
}

// Pi tools granted to each role (0.7.0 ROLE_TOOLS). Result-only repair is inspection-only.
export const ROLE_TOOLS: Record<Role | "repair", string[]> = {
  scout: ["read", "grep", "find", "ls"],
  research: [
    "read",
    "grep",
    "find",
    "ls",
    "web_enable",
    "web_search",
    "fetch_content",
    "get_search_content",
  ],
  planner: ["read", "grep", "find", "ls"],
  builder: ["read", "bash", "edit", "write"],
  reviewer: ["read", "grep", "find", "ls"],
  repair: ["read", "grep", "find", "ls"],
};

export const TERMINAL: readonly AgentStatus[] = AGENT_STATUSES;
