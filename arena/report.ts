import { join } from "node:path";
import { readMatrix } from "./matrix.ts";
import { isMissing } from "../engine/storage/io.ts";
import { regularBytes } from "./evidence.ts";
import { pathToFileURL } from "node:url";
import { cellState, readBatch, type Batch } from "./ledger.ts";

const escape = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");
export function renderReport(batches: readonly Batch[]): string {
  const identities = new Set<string>();
  const cellIds = new Set<string>();
  const lines = [
    "# Coding arena — analysis version 1",
    "",
    "Every requested cell is retained. Oracle correctness and workflow verification are separate. Offline controls establish harness behavior only.",
    "",
  ];
  for (const batch of batches) {
    if (identities.has(batch.manifest.batch)) throw new Error("Duplicate batch identity");
    identities.add(batch.manifest.batch);
    lines.push(
      `## Batch ${batch.manifest.batch}`,
      "",
      `Source: ${batch.manifest.source.revision ?? "unknown"}; Node ${batch.manifest.source.node}; Pi dependency ${batch.manifest.source.pi ?? "unknown"}; ${batch.manifest.source.platform}/${batch.manifest.source.architecture}.`,
      "",
      "| Cell | Task / trial | Requested condition | Execution | Oracle | Usage | Workflow | Attempts |",
      "| --- | --- | --- | --- | --- | --- | --- | ---: |",
    );
    for (const cell of batch.cells) {
      if (cellIds.has(cell.cell.id)) throw new Error("Duplicate cell identity across batches");
      cellIds.add(cell.cell.id);
      const result = cell.results.at(-1);
      const usage = result?.usage;
      const total = usage?.total;
      const usageText =
        usage?.complete && total
          ? `${total.input + total.cacheRead + total.cacheWrite} input (${total.cacheRead} cached reads, ${total.cacheWrite} writes), ${total.output} output; cost ${total.cost ?? "unknown"}`
          : `unknown (${usage?.missingAttempts?.length ?? 0} missing attempts)`;
      lines.push(
        `| ${cell.cell.id} | ${escape(cell.cell.task)} v${cell.cell.taskVersion} / ${cell.cell.trial} | ${escape(cell.cell.requested.system)} / ${cell.cell.requested.workflow} | ${cellState(cell)} | ${result ? `${result.oracle.state} ${result.oracle.passed}/${result.oracle.total}` : "not_scored"} | ${usageText} | ${result?.treatment.verified ? "supervised control" : "unverified"}; eligible: ${result?.treatment.comparisonEligible ?? false} | ${cell.results.length + (cell.active ? 1 : 0)} |`,
      );
    }
    lines.push(
      "",
      `Requested cells: ${batch.manifest.cells.length}. Completed execution: ${batch.cells.filter((cell) => cellState(cell) === "completed").length}. Passing delivered candidates: ${batch.cells.filter((cell) => cell.results.at(-1)?.oracle.state === "pass").length}.`,
      "",
      "All attempts:",
      "",
    );
    for (const cell of batch.cells) {
      for (const result of cell.results)
        lines.push(
          `- ${cell.cell.id}/${result.attempt}: ${result.state}, ${result.elapsedMs === null ? "unknown elapsed time" : `${result.elapsedMs.toFixed(1)} ms trial total`}, oracle ${result.oracle.state}. ${escape([...result.reasons, ...result.treatment.reasons, ...(result.oracle.error ? [result.oracle.error] : [])].join("; "))}`,
        );
      if (cell.active)
        lines.push(
          `- ${cell.cell.id}/${cell.active.attempt}: interrupted_unknown. No final result was durably published; explicit reconciliation is required before retry.`,
        );
    }
    lines.push(
      "",
      "Provenance limitations:",
      "",
      ...batch.manifest.source.limitations.map((reason) => `- ${escape(reason)}`),
      "",
    );
  }
  return lines.join("\n");
}
export async function reportBatches(paths: readonly string[]): Promise<string> {
  if (!paths.length) throw new Error("Supply complete batch directories");
  const batches: Batch[] = [];
  const matrixReports: string[] = [];
  const identities = new Set<string>();
  for (const path of paths) {
    let manifest;
    try {
      manifest = JSON.parse((await regularBytes(join(path, "manifest.json"))).toString());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const matrix = await readMatrix(path);
      if (identities.has(matrix.schedule.matrix)) throw new Error("Duplicate matrix identity");
      identities.add(matrix.schedule.matrix);
      const rows = [
        `## Matrix ${matrix.schedule.matrix}`,
        "",
        "Every predeclared matrix cell is shown, including batches that were never started.",
        "",
        "| Order | Round | Condition | Task | Batch | State |",
        "| ---: | ---: | --- | --- | --- | --- |",
      ];
      for (const [index, cell] of matrix.schedule.cells.entries()) {
        const batch = matrix.batches[index];
        rows.push(
          `| ${cell.order} | ${cell.round} | ${escape(cell.condition)} | ${escape(cell.task)} | ${cell.batch} | ${batch ? cellState(batch.cells[0]) : "pending"} |`,
        );
        if (batch) {
          if (identities.has(batch.manifest.batch)) throw new Error("Duplicate batch identity");
          identities.add(batch.manifest.batch);
          batches.push(batch);
        }
      }
      matrixReports.push(rows.join("\n"));
      continue;
    }
    const id = manifest.batch;
    if (identities.has(id)) throw new Error("Duplicate batch identity");
    identities.add(id);
    batches.push(await readBatch(path));
  }
  return [...matrixReports, renderReport(batches)].join("\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${await reportBatches(process.argv.slice(2))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
