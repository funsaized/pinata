import { join } from "node:path";
import { z } from "zod";
import { type Artifact, type Limits, type Oracle, type Snapshot } from "./contracts.ts";
import { prepareOracle, type FrozenTask } from "./corpus.ts";
import { EvidenceStore, materializeSnapshot } from "./evidence.ts";
import { runProcess } from "./process.ts";

const scoreSchema = z.strictObject({
  schemaVersion: z.literal(1),
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  failed: z.array(z.string()),
  cases: z.array(
    z.strictObject({
      id: z.number().int().nonnegative(),
      passed: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});
export function validateScore(value: unknown, expected: number): z.infer<typeof scoreSchema> {
  const score = scoreSchema.parse(value);
  if (
    score.total !== expected ||
    score.cases.length !== expected ||
    score.cases.some((entry, index) => entry.id !== index || (!entry.passed && !entry.error)) ||
    score.passed !== score.cases.filter((entry) => entry.passed).length ||
    score.failed.length !== expected - score.passed
  )
    throw new Error("Oracle did not return the exact complete case vector");
  return score;
}
export async function scoreSnapshot(options: {
  task: FrozenTask;
  snapshot: Snapshot;
  reference: Artifact;
  store: EvidenceStore;
  directory: string;
  limits: Limits;
  signal?: AbortSignal;
}): Promise<Oracle> {
  const evidence: Artifact[] = [];
  try {
    const oracle = await prepareOracle(
      options.task,
      options.store,
      join(options.directory, "private"),
    );
    evidence.push(...oracle.evidence);
    const candidate = join(options.directory, "scored-candidate");
    await materializeSnapshot(options.snapshot, options.store, candidate);
    const env: Record<string, string> = {
      ARENA_ORACLE_TIMEOUT_MS: String(options.limits.oracleTimeoutMs),
    };
    for (const key of ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TZ", "ARENA_CHROMIUM_BIN"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    const execution = await runProcess({
      directory: join(options.directory, "oracle-supervisor"),
      command: process.execPath,
      args: [oracle.launcher, oracle.file, candidate],
      cwd: options.directory,
      env,
      store: options.store,
      limits: options.limits,
      timeoutMs: options.limits.oracleTimeoutMs,
      signal: options.signal,
    });
    evidence.push(...execution.evidence);
    if (
      execution.state !== "completed" ||
      execution.exit.signal ||
      ![0, 1].includes(execution.exit.code ?? -1)
    )
      throw new Error(`Oracle execution ${execution.state}/${execution.exit.code}`);
    const score = validateScore(
      JSON.parse(execution.stdout.toString()),
      options.task.task.oracleCaseCount,
    );
    if ((score.passed === score.total) !== (execution.exit.code === 0))
      throw new Error("Oracle exit disagrees with score");
    return {
      state: score.passed === score.total ? "pass" : "fail",
      snapshot: options.reference,
      total: score.total,
      passed: score.passed,
      cases: score.cases,
      evidence,
    };
  } catch (error) {
    return {
      state: "scorer_error",
      snapshot: options.reference,
      total: 0,
      passed: 0,
      cases: [],
      evidence,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
