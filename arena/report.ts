import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
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

function assertUniqueTrials(results: RunResult[]): void {
  const runs = new Set<string>();
  const cells = new Set<string>();
  const orders = new Set<string>();
  for (const result of results) {
    const run = canonical([result.batchId, result.runId]);
    const cell = canonical([
      result.batchId,
      result.task.id,
      result.task.version,
      result.workflow,
      result.trial,
    ]);
    const order = canonical([result.batchId, result.order]);
    if (runs.has(run))
      throw new Error(`Duplicate trial identity: ${result.batchId}/${result.runId}`);
    if (cells.has(cell))
      throw new Error(`Duplicate requested trial cell: ${result.batchId}/${result.runId}`);
    if (orders.has(order))
      throw new Error(`Duplicate trial order: ${result.batchId}/${result.order}`);
    runs.add(run);
    cells.add(cell);
    orders.add(order);
  }
}

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
      "External workflow labels and stage events are adapter claims. Supervisor-owned stage evidence is not implemented; external trials are excluded from treatment comparisons even when their candidates pass the oracle.",
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
  assertUniqueTrials(results);
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

interface BatchManifest {
  schemaVersion: 1;
  batchId: string;
  mode: RunResult["mode"];
  tasks: Array<Pick<RunResult["task"], "id" | "version">>;
  workflows: RunResult["workflow"][];
  trials: number;
  adapter: RunResult["adapter"];
  limits: RunResult["provenance"]["limits"];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const measurement = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
const workflowNames = ["sequential", "parallel", "sequential-review", "parallel-review", "native"];

function artifact(path: string, directory = false): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) throw new Error(`Incomplete batch: missing ${path}`);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
    throw new Error(
      `Expected a regular ${directory ? "directory" : "file"}, not a symlink: ${path}`,
    );
  }
}

function readJson(path: string): unknown {
  artifact(path);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Malformed JSON artifact: ${path}: ${String(error)}`);
  }
}

function manifestAt(path: string): BatchManifest {
  const value = readJson(path);
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    typeof value.batchId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value.batchId) ||
    !["scripted-control", "external"].includes(String(value.mode)) ||
    !positiveInteger(value.trials) ||
    value.trials > 100 ||
    !strings(value.workflows) ||
    !value.workflows.length ||
    !value.workflows.every((workflow) => workflowNames.includes(workflow)) ||
    new Set(value.workflows).size !== value.workflows.length ||
    (value.mode === "scripted-control" && value.workflows.includes("native")) ||
    !Array.isArray(value.tasks) ||
    !value.tasks.length ||
    !value.tasks.every(
      (task) =>
        record(task) &&
        typeof task.id === "string" &&
        /^[a-z0-9][a-z0-9_-]*$/.test(task.id) &&
        positiveInteger(task.version),
    ) ||
    new Set(value.tasks.map((task) => task.id)).size !== value.tasks.length ||
    !record(value.adapter) ||
    typeof value.adapter.name !== "string" ||
    typeof value.adapter.command !== "string" ||
    !record(value.limits) ||
    ![
      "timeoutMs",
      "oracleTimeoutMs",
      "maxRepairs",
      "maxLogBytes",
      "maxTreeFiles",
      "maxTreeBytes",
      "maxFileBytes",
      "maxTreeDepth",
    ].every(
      (key) =>
        Number.isSafeInteger((value.limits as Record<string, unknown>)[key]) &&
        Number((value.limits as Record<string, unknown>)[key]) >= 0,
    ) ||
    !positiveInteger(value.limits.timeoutMs) ||
    !positiveInteger(value.limits.oracleTimeoutMs)
  ) {
    throw new Error(`Unsupported batch manifest: ${path}`);
  }
  return value as unknown as BatchManifest;
}

function resultAt(path: string): RunResult {
  const value = readJson(path);
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    typeof value.batchId !== "string" ||
    typeof value.runId !== "string" ||
    !positiveInteger(value.trial) ||
    !positiveInteger(value.order) ||
    !record(value.task) ||
    typeof value.task.id !== "string" ||
    !positiveInteger(value.task.version) ||
    typeof value.task.title !== "string" ||
    !workflowNames.includes(String(value.workflow)) ||
    !["scripted-control", "external"].includes(String(value.mode)) ||
    !(
      value.control === null ||
      ["known-good", "noop", "broken", "repair-control"].includes(String(value.control))
    ) ||
    !["pending", "running", "completed", "failed"].includes(String(value.status)) ||
    !record(value.adapter) ||
    typeof value.adapter.name !== "string" ||
    !strings(value.errors) ||
    !measurement(value.elapsedMs) ||
    !record(value.provenance) ||
    !record(value.provenance.runtime) ||
    !record(value.provenance.limits) ||
    !["arenaSourceSha256", "corpusSha256", "promptSha256", "starterSha256", "configSha256"].every(
      (key) => typeof (value.provenance as Record<string, unknown>)[key] === "string",
    ) ||
    (value.candidateCorrect !== undefined &&
      value.candidateCorrect !== null &&
      typeof value.candidateCorrect !== "boolean") ||
    (value.comparisonEligible !== undefined && typeof value.comparisonEligible !== "boolean") ||
    (value.treatment !== undefined &&
      (!record(value.treatment) ||
        !["verified-control", "unverified", "invalid"].includes(String(value.treatment.status)) ||
        !strings(value.treatment.reasons))) ||
    (value.adapterProcess !== null &&
      (!record(value.adapterProcess) || !measurement(value.adapterProcess.elapsedMs))) ||
    (value.oracle !== null &&
      (!record(value.oracle) ||
        !Number.isSafeInteger(value.oracle.passed) ||
        Number(value.oracle.passed) < 0 ||
        !positiveInteger(value.oracle.total) ||
        Number(value.oracle.passed) > value.oracle.total ||
        !strings(value.oracle.failed))) ||
    (value.response !== null &&
      (!record(value.response) ||
        !record(value.response.framework) ||
        !record(value.response.usage) ||
        !["inputTokens", "outputTokens", "costUsd"].every((key) =>
          measurement((value.response as { usage: Record<string, unknown> }).usage[key]),
        ) ||
        !measurement(value.response.attempts) ||
        !measurement(value.response.repairs) ||
        !strings(value.response.limitations) ||
        !Array.isArray(value.response.events) ||
        !value.response.events.every(
          (event) =>
            record(event) &&
            typeof event.stage === "string" &&
            typeof event.status === "string" &&
            (event.elapsedMs === undefined || measurement(event.elapsedMs)),
        )))
  ) {
    throw new Error(`Unsupported result artifact: ${path}`);
  }
  return value as unknown as RunResult;
}

/** Load complete explicit batch directories; never infer a denominator from files found. */
export function loadResults(paths: string[]): RunResult[] {
  if (!paths.length) throw new Error("At least one batch directory is required");
  const results: RunResult[] = [];
  const directories = new Set<string>();
  const batches = new Set<string>();
  for (const input of paths) {
    const path = resolve(input);
    artifact(path, true);
    const directory = realpathSync(path);
    if (directories.has(directory)) throw new Error(`Duplicate batch directory: ${input}`);
    directories.add(directory);
    const manifest = manifestAt(join(directory, "manifest.json"));
    if (batches.has(manifest.batchId))
      throw new Error(`Duplicate batch identity: ${manifest.batchId}`);
    batches.add(manifest.batchId);
    const runs = join(directory, "runs");
    artifact(runs, true);
    const expected = new Map<
      string,
      {
        task: BatchManifest["tasks"][number];
        workflow: RunResult["workflow"];
        trial: number;
        order: number;
      }
    >();
    for (const task of manifest.tasks)
      for (let trial = 1; trial <= manifest.trials; trial++)
        for (const workflow of manifest.workflows) {
          const runId = `${task.id}-${workflow}-trial-${trial}`;
          expected.set(runId, { task, workflow, trial, order: expected.size + 1 });
        }
    const actual = new Set(readdirSync(runs));
    for (const runId of actual)
      if (!expected.has(runId)) throw new Error(`Unexpected trial artifact: ${join(runs, runId)}`);
    const batch: RunResult[] = [];
    for (const [runId, planned] of expected) {
      const run = join(runs, runId);
      artifact(run, true);
      const result = resultAt(join(run, "result.json"));
      if (
        result.batchId !== manifest.batchId ||
        result.runId !== runId ||
        result.task.id !== planned.task.id ||
        result.task.version !== planned.task.version ||
        result.workflow !== planned.workflow ||
        result.trial !== planned.trial ||
        result.order !== planned.order ||
        result.mode !== manifest.mode ||
        (result.mode === "external" ? result.control !== null : result.control === null) ||
        canonical(result.adapter) !== canonical(manifest.adapter) ||
        canonical(result.provenance.limits) !== canonical(manifest.limits)
      ) {
        throw new Error(
          `Result identity or configuration does not match batch manifest: ${join(run, "result.json")}`,
        );
      }
      batch.push(result);
    }
    if (
      unique(batch.map((result) => result.control)) !== 1 ||
      unique(batch.map((result) => result.provenance.configSha256)) !== 1
    ) {
      throw new Error(`Conflicting control configuration within batch: ${manifest.batchId}`);
    }
    results.push(...batch);
  }
  assertUniqueTrials(results);
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
