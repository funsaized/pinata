import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "./runner.ts";

const cell = (value: unknown) =>
  String(value)
    .replaceAll("|", "\\|")
    .replace(/[\r\n]/g, " ");
const number = (value: number | null | undefined, digits = 0) =>
  value == null ? "unknown" : value.toFixed(digits);
const model = (result: RunResult) => result.response?.model ?? null;
const correctness = (result: RunResult) =>
  result.candidateCorrect === true
    ? "pass"
    : result.candidateCorrect === false
      ? "fail"
      : "unknown";
const treatment = (result: RunResult) =>
  result.mode === "external" ? "unverified" : (result.treatment?.status ?? "unverified");
// External self-reports cannot opt themselves into a comparison. Keep every
// requested control cell, including interrupted/setup-failed cells, in its group.
const eligible = (result: RunResult) =>
  result.mode === "scripted-control" && result.comparisonEligible === true;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const unique = (values: unknown[]) => new Set(values.map(canonical)).size;

export function comparisonWarnings(results: RunResult[]): string[] {
  const warnings: string[] = [];
  if (results.some((result) => result.mode === "scripted-control"))
    warnings.push(
      "Scripted controls validate the harness only. Their timings, tokens and costs are not evidence about live coding models or frameworks.",
    );
  if (unique(results.map((result) => result.mode)) > 1)
    warnings.push("Mixed scripted and external runs are not comparable.");
  if (unique(results.map((result) => result.provenance.configSha256)) > 1)
    warnings.push(
      "Adapter configurations differ. When the adapter is the intended treatment, match task, model settings and resource limits, and disclose other differences.",
    );
  if (unique(results.map((result) => result.provenance.runtime)) > 1)
    warnings.push(
      "Runtime or machine characteristics differ; wall times are not directly comparable.",
    );
  if (
    unique(
      results.map((result) => [
        result.provenance.arenaSourceSha256,
        result.provenance.lockfileSha256,
      ]),
    ) > 1
  )
    warnings.push("Harness source or lockfile differs between runs.");
  if (unique(results.map((result) => result.provenance.adapterSourceSha256)) > 1)
    warnings.push("Adapter command source differs between runs.");
  if (
    results.some((result) => result.mode === "external" && !result.provenance.adapterSourceSha256)
  )
    warnings.push(
      "Some external command sources could not be fingerprinted; adapter equivalence is unknown.",
    );
  const external = results.filter((result) => result.mode === "external");
  if (external.length) {
    warnings.push(
      "External workflow labels and stage events are adapter claims. Supervisor-owned stage evidence and live Piñata/Pi/OpenCode integrations are not implemented; external trials are excluded from treatment comparisons even when their candidates pass the oracle.",
    );
    warnings.push(
      "External adapter source fingerprints have partial coverage: direct command files do not cover imported modules, packages, shell/PATH resolution or remote services. A matching hash does not establish adapter equivalence.",
    );
  }
  if (external.some((result) => !model(result) || !model(result)?.version))
    warnings.push(
      "Some external model identities or versions are unknown; model equivalence is unverified.",
    );
  if (unique(external.map(model)) > 1)
    warnings.push("Reported model identity, version or settings differs between external runs.");
  if (
    external.some(
      (result) =>
        result.response &&
        result.adapter.model &&
        canonical(result.adapter.model) !== canonical(result.response.model),
    )
  )
    warnings.push(
      "A reported model differs from the configured model; requested model settings were not verified.",
    );
  if (unique(external.map((result) => result.response?.framework ?? null)) > 1)
    warnings.push("Reported framework identity or version differs between external runs.");
  for (const id of new Set(results.map((result) => result.task.id))) {
    const rows = results.filter((result) => result.task.id === id);
    if (
      unique(
        rows.map((result) => [
          result.task.version,
          result.provenance.corpusSha256,
          result.provenance.promptSha256,
          result.provenance.starterSha256,
          result.provenance.startingRevision,
        ]),
      ) > 1
    )
      warnings.push(
        `Task ${id} has mismatched corpus, prompts or starting revisions; its treatments are not comparable.`,
      );
  }
  return warnings;
}

export function renderReport(results: RunResult[]): string {
  const lines = [
    "# Coding arena report",
    "",
    `${results.length} requested trial cells recorded. ${results.filter((result) => result.candidateCorrect === true).length} candidates passed all attributable oracle checks; ${results.filter((result) => treatment(result) === "unverified").length} treatments are unverified. ${results.filter((result) => !eligible(result)).length} trials are excluded from treatment comparisons.`,
    "",
    "Each row is one requested trial, including failed setup, adapter errors, timeouts and missing responses. Unknown means unavailable; it never means zero. Candidate correctness comes from the oracle and stable-snapshot checks, independently of execution status and treatment verification. External model, framework, usage, attempts, repairs and stage events are adapter-reported. Verified-control means mechanically checked scripted harness execution, with no live framework claim. Eligibility preserves every requested scripted control in its comparison denominator, including failures; external trials and legacy artifacts without eligibility metadata are ineligible.",
    "",
    "## Interpretation",
    "",
    ...comparisonWarnings(results).map((warning) => `- ${warning}`),
    "- Trials execute in fixed task, trial, workflow order. Cache, machine load and order can confound timings. Repeated controls do not establish statistical significance.",
    "- Wall time includes setup, adapter, evaluation and snapshot work. Adapter time measures the bounded subprocess. Token/cost fields are totals reported by the adapter; stage-level accounting may be unavailable.",
    "- Candidate files are separated from oracle and solution files, but execution is not an operating-system security sandbox. External commands must be trusted. POSIX process groups are cleaned up; detached descendants can escape, and Windows child cleanup is best effort.",
    "",
    "## All trials",
    "",
    "| Batch | Task | Requested workflow | Trial / order | Mode / control | Execution status | Candidate correctness | Treatment | Comparison eligible | Oracle score | Wall s | Adapter s | Input tokens | Output tokens | USD | Attempts | Repairs |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const result of results) {
    const response = result.response;
    lines.push(
      `| ${[
        result.batchId,
        result.task.id,
        result.workflow,
        `${result.trial} / ${result.order}`,
        result.control ?? result.mode,
        result.status,
        correctness(result),
        treatment(result),
        eligible(result) ? "yes" : "no",
        result.oracle ? `${result.oracle.passed}/${result.oracle.total}` : "unknown",
        number(result.elapsedMs == null ? null : result.elapsedMs / 1000, 3),
        number(result.adapterProcess ? result.adapterProcess.elapsedMs / 1000 : null, 3),
        number(response?.usage.inputTokens),
        number(response?.usage.outputTokens),
        number(response?.usage.costUsd, 6),
        number(response?.attempts),
        number(response?.repairs),
      ]
        .map(cell)
        .join(" | ")} |`,
    );
  }
  lines.push(
    "",
    "## Scripted control treatment comparisons",
    "",
    "Only scripted controls enter this table. Counts retain every requested control cell in the denominator, including unavailable responses, invalid treatment evidence and unstarted trials. A successful control requires completed execution, a verified scripted treatment and a passing candidate. Batches remain separate, so incompatible configurations are never pooled and missing telemetry cannot remove a failure from its control group. External trials remain in All trials and the exclusion counts below. These are descriptive harness counts, not a framework ranking.",
    "",
    "| Task | Batch / mode | Workflow | Verified, completed and correct / requested | Oracle observed / requested | Usage observed / requested |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  const groups = new Map<string, RunResult[]>();
  for (const result of results) {
    if (!eligible(result)) continue;
    const key = `${result.task.id}|${result.batchId} / ${result.mode}|${result.workflow}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  for (const [key, rows] of groups) {
    const [task, config, workflow] = key.split("|");
    const observed = rows.filter(
      (row) =>
        row.response &&
        row.response.usage.inputTokens !== null &&
        row.response.usage.outputTokens !== null &&
        row.response.usage.costUsd !== null,
    ).length;
    lines.push(
      `| ${cell(task)} | ${cell(config)} | ${cell(workflow)} | ${rows.filter((row) => row.status === "completed" && row.candidateCorrect === true && treatment(row) === "verified-control").length}/${rows.length} | ${rows.filter((row) => row.oracle).length}/${rows.length} | ${observed}/${rows.length} |`,
    );
  }
  const excluded = results.filter((result) => result.mode === "external");
  const legacy = results.filter(
    (result) => result.mode === "scripted-control" && !eligible(result),
  );
  lines.push(
    "",
    `Excluded external trials: ${excluded.length}/${results.length} requested cells; ${excluded.filter((result) => result.candidateCorrect === true).length} passing candidates, ${excluded.filter((result) => result.candidateCorrect === false).length} failing candidates, ${excluded.filter((result) => result.candidateCorrect == null).length} unknown correctness. All ${excluded.length} external treatments are unverified, regardless of reported events or counts.`,
    `Other excluded trials without explicit comparison eligibility: ${legacy.length}/${results.length} requested cells. Their evidence remains in All trials.`,
  );
  lines.push("", "## Evidence and failures", "");
  for (const result of results) {
    const response = result.response;
    const reportedModel = model(result);
    lines.push(
      `### ${cell(result.batchId)} / ${cell(result.runId)}`,
      "",
      `Adapter: ${cell(result.adapter.name)}. Framework: ${response ? `${cell(response.framework.name)} @ ${cell(response.framework.version ?? "unknown")}` : "unknown"}. Model: ${reportedModel ? `${cell(reportedModel.provider)}/${cell(reportedModel.id)} @ ${cell(reportedModel.version ?? "unknown")}` : "unknown"}. Usage source: ${cell(response?.usage.source ?? "unknown")}.`,
      "",
      `Starter commit: \`${result.provenance.startingRevision ?? "unknown"}\`. Corpus: \`${result.provenance.corpusSha256 || "unknown"}\`. Prompt: \`${result.provenance.promptSha256}\`.`,
      "",
      `Candidate correctness: ${correctness(result)}. Treatment: ${treatment(result)}. Comparison eligible: ${eligible(result) ? "yes (scripted control denominator)" : "no"}. Adapter source coverage: ${cell(result.provenance.adapterSourceCoverage ?? "unknown")}.`,
      "",
    );
    if (result.treatment?.reasons.length)
      lines.push(
        ...result.treatment.reasons.map((reason) => `- Treatment evidence: ${cell(reason)}`),
        "",
      );
    if (result.provenance.adapterSourceLimitations?.length)
      lines.push(
        ...result.provenance.adapterSourceLimitations.map(
          (limitation) => `- Provenance limitation: ${cell(limitation)}`,
        ),
        "",
      );
    if (result.errors.length)
      lines.push(...result.errors.map((error) => `- Failure: ${cell(error)}`), "");
    if (result.oracle?.failed.length)
      lines.push(...result.oracle.failed.map((failure) => `- Oracle: ${cell(failure)}`), "");
    if (response?.limitations.length)
      lines.push(
        ...response.limitations.map((limitation) => `- Adapter limitation: ${cell(limitation)}`),
        "",
      );
    if (response?.events.length) {
      lines.push("| Stage | Unit | Status | ms | Detail |", "| --- | --- | --- | ---: | --- |");
      for (const event of response.events)
        lines.push(
          `| ${[event.stage, event.unit ?? "—", event.status, number(event.elapsedMs, 3), event.detail ?? ""].map(cell).join(" | ")} |`,
        );
      lines.push("");
    } else lines.push("Stage events: unknown.", "");
  }
  lines.push(
    "Per-run result.json records full provenance and limits. request.json is the adapter input. evidence/ retains capped stdout/stderr, parsed responses, final-snapshot.json and a tracked-file final.diff; the preserved candidate directory contains new/untracked files too. Truncation and process exits are recorded in result.json. A missing artifact means its stage did not reach that point.",
    "",
  );
  return lines.join("\n");
}

export function loadResults(paths: string[]): RunResult[] {
  const results: RunResult[] = [];
  function visit(path: string) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort())
        if (name !== "candidate" && name !== "evidence" && name !== ".git") visit(join(path, name));
    } else if (path.endsWith("result.json")) {
      const value = JSON.parse(readFileSync(path, "utf8")) as RunResult;
      if (
        value.schemaVersion !== 1 ||
        !value.provenance ||
        !value.task ||
        !Array.isArray(value.errors)
      )
        throw new Error(`Unsupported result artifact: ${path}`);
      results.push(value);
    }
  }
  for (const path of paths) visit(resolve(path));
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length < 3)
      throw new Error("Usage: node arena/report.ts BATCH_DIR [BATCH_DIR ...]");
    process.stdout.write(renderReport(loadResults(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
