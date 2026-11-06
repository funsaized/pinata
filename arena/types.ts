// Versioned protocol shared by the corpus, runner, and adapters.
export type Workflow = "sequential" | "parallel" | "sequential-review" | "parallel-review";
export interface Unit {
  id: string;
  prompt: string;
  files: string[];
}
export interface ArenaTask {
  id: string;
  version: number;
  title: string;
  prompt: string;
  starterDir: string;
  solutionDir: string; // Offline controls only; never supplied to external adapters.
  oracleFile: string; // Run in a separate bounded process, outside the candidate tree.
  oracleCaseCount: number; // Trusted expected denominator, never supplied by a candidate.
  units: Unit[];
}
export interface AdapterRequest {
  schemaVersion: 1;
  runId: string;
  task: { id: string; version: number; prompt: string; units: Unit[] };
  workflow: Workflow;
  cwd: string;
  evidenceDir: string;
  startingRevision: string;
  model: {
    provider: string;
    id: string;
    version: string | null;
    settings: Record<string, unknown>;
  } | null;
  limits: { timeoutMs: number; maxRepairs: number };
}
export interface AdapterResponse {
  schemaVersion: 1;
  status: "completed" | "failed";
  framework: { name: string; version: string | null };
  model: AdapterRequest["model"];
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    source: string;
  };
  attempts: number | null;
  repairs: number | null;
  events: Array<{
    stage: string;
    unit?: string;
    status: string;
    elapsedMs?: number;
    detail?: string;
  }>;
  limitations: string[];
}
