import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { regularBytes } from "./evidence.ts";
import { workflowSchema } from "./contracts.ts";

// Read-only v1 codecs preserve the original payload. They never reinterpret old
// treatment/usage fields as v2 supervisor or complete-coverage evidence.
const legacyManifestSchema = z.looseObject({
  schemaVersion: z.literal(1),
  batchId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  trials: z.number().int().positive(),
  workflows: z.array(workflowSchema).min(1),
  tasks: z
    .array(z.strictObject({ id: z.string().min(1), version: z.number().int().positive() }))
    .min(1),
});
const legacyResultSchema = z.looseObject({
  schemaVersion: z.literal(1),
  batchId: z.string(),
  runId: z.string(),
  trial: z.number().int().positive(),
  order: z.number().int().positive(),
  task: z.looseObject({ id: z.string(), version: z.number().int().positive(), title: z.string() }),
  workflow: workflowSchema,
  status: z.enum(["pending", "running", "completed", "failed"]),
  candidateCorrect: z.boolean().nullable(),
  comparisonEligible: z.boolean(),
  errors: z.array(z.string()),
  oracle: z
    .looseObject({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .nullable(),
});
export type HistoricalBatch = {
  manifest: z.infer<typeof legacyManifestSchema>;
  results: z.infer<typeof legacyResultSchema>[];
};
export async function readHistoricalBatch(directory: string): Promise<HistoricalBatch> {
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Historical batch cannot be a symbolic link");
  const manifest = legacyManifestSchema.parse(
    JSON.parse((await regularBytes(join(directory, "manifest.json"))).toString()),
  );
  if (
    new Set(manifest.workflows).size !== manifest.workflows.length ||
    new Set(manifest.tasks.map((task) => task.id)).size !== manifest.tasks.length
  )
    throw new Error("Duplicate historical schedule identities");
  const results: HistoricalBatch["results"] = [];
  const expected: string[] = [];
  for (const task of manifest.tasks)
    for (let trial = 1; trial <= manifest.trials; trial++)
      for (const workflow of manifest.workflows) {
        const id = `${task.id}-${workflow}-trial-${trial}`;
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Unsafe historical run identity");
        expected.push(id);
        const path = join(directory, "runs", id);
        if ((await lstat(path)).isSymbolicLink())
          throw new Error("Historical run cannot be a symbolic link");
        const result = legacyResultSchema.parse(
          JSON.parse((await regularBytes(join(path, "result.json"))).toString()),
        );
        if (
          result.batchId !== manifest.batchId ||
          result.runId !== id ||
          result.trial !== trial ||
          result.workflow !== workflow ||
          result.task.id !== task.id ||
          result.task.version !== task.version ||
          result.order !== results.length + 1
        )
          throw new Error("Historical result differs from schedule");
        results.push(result);
      }
  const actual = await readdir(join(directory, "runs"));
  if (actual.length !== expected.length || actual.some((name) => !expected.includes(name)))
    throw new Error("Missing or unexpected historical trial");
  return { manifest, results };
}
export function renderHistoricalReport(batch: HistoricalBatch): string {
  const lines = [
    `## Historical v1 batch ${batch.manifest.batchId}`,
    "",
    "Original v1 observations are shown without upgrading workflow verification or usage coverage. The source evidence is unchanged.",
    "",
    "| Trial | Execution | Candidate correctness | Oracle |",
    "| --- | --- | --- | --- |",
  ];
  for (const result of batch.results)
    lines.push(
      `| ${result.runId} | ${result.status} | ${result.candidateCorrect ?? "unknown"} | ${result.oracle ? `${result.oracle.passed}/${result.oracle.total}` : "not_scored"} |`,
    );
  return `${lines.join("\n")}\n`;
}
