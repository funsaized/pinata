import { join } from "node:path";
import type { TaskSpec } from "../core/types.ts";
import { atomicJson, privateDir, readJson } from "../core/store.ts";
export type IntegrationMode = "manual" | "apply";
export interface RunRecord {
  schemaVersion?: 2 | 3;
  definitions?: import("../core/definitions.ts").Definitions;
  id: string;
  root: string;
  store?: string;
  head: string;
  branch?: string;
  integration?: IntegrationMode;
  tasks: TaskSpec[];
  allowWrites: boolean;
  passEnv: string[];
  resume?: {
    mode: "lean" | "observe";
    data: Record<string, unknown>;
    survive: boolean;
    background: boolean;
    owner: { pid: number; started: string; host?: string } | null;
  };
}
export async function writeRunRecord(dir: string, record: RunRecord): Promise<void> {
  await privateDir(dir);
  await atomicJson(join(dir, "run.json"), record);
}
export async function readRunRecord(dir: string): Promise<RunRecord> {
  const record = await readJson<RunRecord>(join(dir, "run.json"));
  if (record.schemaVersion !== undefined && ![2, 3].includes(record.schemaVersion))
    throw new Error(`Unsupported run record schema: ${record.schemaVersion}`);
  return record;
}
export function requireCurrentRecord(record: RunRecord): void {
  if (record.schemaVersion !== 3)
    throw new Error(
      "Legacy run is read-only. Stop or preserve its old workers, inspect saved patches, and migrate its job to start a new run.",
    );
}
