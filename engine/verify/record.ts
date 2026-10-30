import { join } from "node:path";
import type { Check, Task } from "../core/types.ts";
import { atomicJson, privateDir, readJson } from "../core/store.ts";

// What the host records when a run starts, for integration after a reload.
export interface RunRecord {
  id: string;
  root: string;
  head: string; // the user's HEAD when the run started
  tasks: Task[];
  allowWrites: boolean;
  integratedChecks: Check[];
  noIntegratedChecksReason: string | null;
  passEnv: string[];
  taskMs: number;
  // What a later Pi needs to resume the run (E6.3), and the Pi that owns it.
  resume?: {
    mode: "lean" | "observe";
    limits: Record<string, unknown>;
    data: Record<string, unknown>;
    survive: boolean;
    background: boolean;
    owner: { pid: number; started: string } | null;
  };
}

export async function writeRunRecord(dir: string, record: RunRecord): Promise<void> {
  await privateDir(dir);
  await atomicJson(join(dir, "run.json"), record);
}

export async function readRunRecord(dir: string): Promise<RunRecord> {
  return readJson<RunRecord>(join(dir, "run.json"));
}
