import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { availableParallelism, cpus, release, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterRequest, AdapterResponse, ArenaTask, Workflow } from "./types.ts";
import type { OfflineMode } from "./adapters/offline.ts";
import { runProcess, type ProcessResult } from "./process.ts";
import { validateUnitGraph } from "./task-graph.ts";
import { renderReport } from "./report.ts";
import { verifyTreatment, type TreatmentVerification } from "./treatment.ts";

export const workflows: Workflow[] = [
  "sequential",
  "parallel",
  "sequential-review",
  "parallel-review",
];
export const externalWorkflows: Workflow[] = [...workflows, "native"];
const arenaDir = dirname(fileURLToPath(import.meta.url));
const repoDir = dirname(arenaDir);
const workerFile = join(arenaDir, "run.ts");
const fixedDate = "2000-01-01T00:00:00Z";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, item: unknown) =>
      record(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    2,
  ) + "\n";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const treeLimits = {
  maxTreeFiles: 10_000,
  maxTreeBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxTreeDepth: 32,
};

export interface AdapterConfig {
  name: string;
  command: string;
  args?: string[];
  model?: AdapterRequest["model"];
  timeoutMs?: number;
}
export interface FileEntry {
  path: string;
  kind: "file" | "symlink";
  sha256?: string;
  bytes?: number;
  executable?: boolean;
  target?: string;
}
type ProcessSummary = Omit<ProcessResult, "stdout" | "stderr" | "score">;
export interface OracleResult {
  schemaVersion: 1;
  passed: number;
  total: number;
  failed: string[];
  cases: Array<{ id: number; passed: boolean; error?: string }>;
}
export interface RunResult {
  schemaVersion: 1;
  batchId: string;
  runId: string;
  trial: number;
  order: number;
  task: { id: string; version: number; title: string };
  workflow: Workflow;
  mode: "scripted-control" | "external";
  control: OfflineMode | null;
  adapter: AdapterConfig;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  adapterProcess: ProcessSummary | null;
  response: AdapterResponse | null;
  oracle: OracleResult | null;
  candidateCorrect: boolean | null;
  treatment: TreatmentVerification;
  comparisonEligible: boolean;
  oracleProcess: ProcessSummary | null;
  errors: string[];
  provenance: {
    repositoryRevision: string | null;
    repositoryStatus: string | null;
    lockfileSha256: string | null;
    arenaSourceSha256: string;
    adapterSourceSha256: string | null;
    adapterSourceCoverage: "partial" | "complete-harness";
    adapterSourceLimitations: string[];
    oracleCaseCount: number;
    scorerProtocol: "separate-process-v1";
    candidateRestrictions: { profile: string; osSandbox: false; networkRestricted: false };
    corpusSha256: string;
    starterSha256: string;
    oracleSha256: string;
    promptSha256: string;
    configSha256: string;
    startingRevision: string | null;
    startingFiles: FileEntry[];
    runtime: {
      node: string;
      platform: string;
      arch: string;
      release: string;
      cpu: string | null;
      parallelism: number;
      totalMemory: number;
    };
    limits: {
      timeoutMs: number;
      oracleTimeoutMs: number;
      maxRepairs: number;
      maxLogBytes: number;
    } & typeof treeLimits;
  };
  finalFiles: FileEntry[] | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validModel(value: unknown): boolean {
  return (
    value === null ||
    (record(value) &&
      typeof value.provider === "string" &&
      !!value.provider &&
      typeof value.id === "string" &&
      !!value.id &&
      (value.version === null || typeof value.version === "string") &&
      record(value.settings))
  );
}
function count(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}
function measurement(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}
export function parseAdapterConfig(value: unknown): AdapterConfig {
  if (
    !record(value) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.command !== "string" ||
    !value.command.trim() ||
    (value.args !== undefined &&
      (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string"))) ||
    (value.model !== undefined && !validModel(value.model)) ||
    (value.timeoutMs !== undefined &&
      (!Number.isInteger(value.timeoutMs) ||
        Number(value.timeoutMs) <= 0 ||
        Number(value.timeoutMs) > 2_147_483_647))
  ) {
    throw new Error(
      "Invalid adapter config: expected name, command, optional string[] args, model and positive timeoutMs",
    );
  }
  return value as unknown as AdapterConfig;
}
export function parseAdapterResponse(raw: string): AdapterResponse {
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    (value.status !== "completed" && value.status !== "failed") ||
    !record(value.framework) ||
    typeof value.framework.name !== "string" ||
    !value.framework.name ||
    !(value.framework.version === null || typeof value.framework.version === "string") ||
    !validModel(value.model) ||
    !record(value.usage) ||
    !count(value.usage.inputTokens) ||
    !count(value.usage.outputTokens) ||
    !measurement(value.usage.costUsd) ||
    typeof value.usage.source !== "string" ||
    !value.usage.source ||
    !count(value.attempts) ||
    !count(value.repairs) ||
    !Array.isArray(value.events) ||
    !value.events.every(
      (event) =>
        record(event) &&
        typeof event.stage === "string" &&
        typeof event.status === "string" &&
        (event.unit === undefined || typeof event.unit === "string") &&
        (event.elapsedMs === undefined ||
          (measurement(event.elapsedMs) && event.elapsedMs !== null)) &&
        (event.detail === undefined || typeof event.detail === "string"),
    ) ||
    !Array.isArray(value.limitations) ||
    !value.limitations.every((item) => typeof item === "string")
  ) {
    throw new Error(
      "Invalid adapter response: expected complete schemaVersion 1 response; unknown measurements must be null",
    );
  }
  return value as unknown as AdapterResponse;
}

export function treeManifest(root: string, exclude: string[] = []): FileEntry[] {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("Snapshot root must be a directory, not a symlink");
  const entries: FileEntry[] = [];
  let bytes = 0;
  let visited = 0;
  function visit(directory: string, depth = 0) {
    if (depth > treeLimits.maxTreeDepth) throw new Error("Tree depth exceeded snapshot limit");
    for (const name of readdirSync(directory).sort()) {
      if (depth === 0 && (name === ".git" || exclude.includes(name))) continue;
      if (++visited > treeLimits.maxTreeFiles)
        throw new Error("Tree file count exceeded snapshot limit");
      const path = join(directory, name);
      const stat = lstatSync(path);
      const portable = relative(root, path).split(sep).join("/");
      if (stat.isSymbolicLink())
        entries.push({ path: portable, kind: "symlink", target: readlinkSync(path) });
      else if (stat.isDirectory()) visit(path, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (stat.size > treeLimits.maxFileBytes || bytes > treeLimits.maxTreeBytes)
          throw new Error(`Tree bytes exceeded snapshot limit: ${portable}`);
        entries.push({
          path: portable,
          kind: "file",
          sha256: hash(readFileSync(path)),
          bytes: stat.size,
          executable: !!(stat.mode & 0o111),
        });
      } else throw new Error(`Unsupported candidate file: ${portable}`);
    }
  }
  visit(root);
  return entries;
}
function copyStarter(task: ArenaTask, candidate: string, files: FileEntry[]) {
  if (existsSync(join(task.starterDir, ".git")))
    throw new Error("Starter must not contain a .git directory");
  for (const file of files) {
    if (file.kind !== "file") throw new Error(`Starter symlink prohibited: ${file.path}`);
    const dest = join(candidate, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(task.starterDir, file.path), dest);
    chmodSync(dest, file.executable ? 0o755 : 0o644);
  }
}
function git(args: string[], cwd: string): string {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Arena",
    GIT_AUTHOR_EMAIL: "arena@localhost",
    GIT_COMMITTER_NAME: "Arena",
    GIT_COMMITTER_EMAIL: "arena@localhost",
    GIT_AUTHOR_DATE: fixedDate,
    GIT_COMMITTER_DATE: fixedDate,
  };
  for (const key of Object.keys(env))
    if (
      /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_PARAMETERS)$/.test(
        key,
      )
    )
      delete env[key as keyof typeof env];
  return execFileSync(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.filemode=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trimEnd();
}
function optionalGit(args: string[]): string | null {
  try {
    return git(args, repoDir);
  } catch {
    return null;
  }
}
function saveResult(directory: string, result: RunResult) {
  const temp = join(directory, "result.json.tmp");
  writeFileSync(temp, json(result));
  renameSync(temp, join(directory, "result.json"));
}
function summary(result: ProcessResult): ProcessSummary {
  const { stdout: _stdout, stderr: _stderr, score: _score, ...rest } = result;
  return rest;
}
function processError(result: ProcessResult, name: string): string | null {
  if (result.timedOut) return `${name} timed out`;
  if (result.error) return `${name}: ${result.error}`;
  if (result.code !== 0)
    return `${name} exited ${result.code ?? result.signal ?? "without a code"}`;
  return null;
}
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonicalPath(parent), relative(parent, absolute));
}
function parseOracle(raw: string, expectedCount: number): OracleResult {
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.passed) ||
    !Number.isSafeInteger(value.total) ||
    value.total !== expectedCount ||
    Number(value.passed) < 0 ||
    Number(value.passed) > Number(value.total) ||
    !Array.isArray(value.failed) ||
    !value.failed.every((item) => typeof item === "string") ||
    value.failed.length !== Number(value.total) - Number(value.passed) ||
    !Array.isArray(value.cases) ||
    value.cases.length !== expectedCount ||
    !value.cases.every(
      (entry, index) =>
        record(entry) &&
        entry.id === index &&
        typeof entry.passed === "boolean" &&
        (entry.passed
          ? entry.error === undefined
          : typeof entry.error === "string" && entry.error.length > 0),
    ) ||
    value.cases.filter((entry) => entry.passed).length !== value.passed ||
    json(value.cases.filter((entry) => !entry.passed).map((entry) => entry.error)) !==
      json(value.failed)
  ) {
    throw new Error(
      `Invalid oracle response: expected ${expectedCount} complete, ordered case observations from the trusted score channel`,
    );
  }
  return value as unknown as OracleResult;
}

export interface ArenaOptions {
  signal?: AbortSignal;
  out: string;
  tasks: ArenaTask[];
  workflows?: Workflow[];
  trials?: number;
  offlineMode?: OfflineMode;
  adapter?: AdapterConfig;
  allowExternal?: boolean;
  timeoutMs?: number;
  oracleTimeoutMs?: number;
  maxRepairs?: number;
  maxLogBytes?: number;
  batchId?: string;
}

export async function runArena(
  options: ArenaOptions,
): Promise<{ directory: string; results: RunResult[] }> {
  if (options.adapter && !options.allowExternal)
    throw new Error("External commands require --allow-external; they may invoke paid models");
  const selectedWorkflows = options.workflows ?? workflows;
  if (!options.adapter && selectedWorkflows.includes("native"))
    throw new Error("The native workflow requires an external adapter");
  const trials = options.trials ?? 1;
  const mode = options.offlineMode ?? "known-good";
  const adapter = options.adapter
    ? parseAdapterConfig(options.adapter)
    : { name: "scripted-control", command: process.execPath, args: [workerFile], model: null };
  const limits = {
    timeoutMs: options.timeoutMs ?? adapter.timeoutMs ?? 60_000,
    oracleTimeoutMs:
      options.oracleTimeoutMs ??
      Math.max(10_000, ...options.tasks.map((task) => task.oracleTimeoutMs ?? 10_000)),
    maxRepairs: options.maxRepairs ?? 1,
    maxLogBytes: options.maxLogBytes ?? 1024 * 1024,
    ...treeLimits,
  };
  if (
    !Number.isInteger(trials) ||
    trials < 1 ||
    trials > 100 ||
    !options.tasks.length ||
    !selectedWorkflows.length ||
    !selectedWorkflows.every((workflow) => externalWorkflows.includes(workflow)) ||
    new Set(selectedWorkflows).size !== selectedWorkflows.length ||
    new Set(options.tasks.map((task) => task.id)).size !== options.tasks.length ||
    Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 0) ||
    limits.timeoutMs < 1 ||
    limits.oracleTimeoutMs < 1 ||
    limits.maxLogBytes < 128 ||
    limits.timeoutMs > 2_147_483_647 ||
    limits.oracleTimeoutMs > 2_147_483_647 ||
    !["known-good", "noop", "broken", "repair-control"].includes(mode)
  )
    throw new Error("Invalid arena options");
  for (const task of options.tasks) {
    validateUnitGraph(task.units);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(task.id)) throw new Error(`Unsafe task id: ${task.id}`);
    if (
      !Number.isSafeInteger(task.oracleCaseCount) ||
      task.oracleCaseCount < 1 ||
      task.oracleCaseCount > 10_000
    )
      throw new Error(`Invalid expected oracle case count for ${task.id}`);
    for (const unit of task.units)
      for (const path of unit.files) {
        if (
          isAbsolute(path) ||
          path.split(/[\\/]/).some((part) => part === ".." || part === ".git") ||
          !path
        )
          throw new Error(`Unsafe task file: ${path}`);
      }
  }
  const batchId =
    options.batchId ??
    `arena-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(batchId)) throw new Error("Unsafe batch id");
  const out = canonicalPath(options.out);
  // Output may live in the repository, but cannot alter corpus or runner inputs.
  const resultsRoot = join(arenaDir, "results");
  if (
    ((out === arenaDir || out.startsWith(arenaDir + sep)) &&
      !(out === resultsRoot || out.startsWith(resultsRoot + sep))) ||
    options.tasks.some((task) =>
      [task.starterDir, task.solutionDir].some(
        (source) => out === canonicalPath(source) || out.startsWith(canonicalPath(source) + sep),
      ),
    )
  ) {
    throw new Error("Output directory must be outside arena source and task inputs");
  }
  mkdirSync(out, { recursive: true });
  const directory = join(out, batchId);
  mkdirSync(directory); // Exclusive reservation: an existing batch is never reused.
  mkdirSync(join(directory, "runs"));
  const sourceFiles = treeManifest(arenaDir, ["results", "PLAN.md"]);
  const sourceHash = hash(json(sourceFiles));
  const repoRevision = optionalGit(["rev-parse", "HEAD"]);
  const repoStatus = optionalGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  const lockPath = join(repoDir, "package-lock.json");
  const adapterFiles = [adapter.command, ...(adapter.args ?? [])].filter(
    (path) => isAbsolute(path) && existsSync(path) && lstatSync(path).isFile(),
  );
  const adapterSourceHash = options.adapter
    ? adapterFiles.length
      ? hash(json(adapterFiles.map((path) => ({ path, sha256: hash(readFileSync(path)) }))))
      : null
    : sourceHash;
  const configHash = hash(json({ adapter, limits, control: options.adapter ? null : mode }));
  const manifest = {
    schemaVersion: 1,
    batchId,
    createdAt: new Date().toISOString(),
    mode: options.adapter ? "external" : "scripted-control",
    trials,
    workflows: selectedWorkflows,
    tasks: options.tasks.map((task) => ({ id: task.id, version: task.version })),
    adapter,
    limits,
    order: "task, trial, workflow; fixed order can confound wall time",
    sourceFiles,
    adapterFiles,
    limitations: [
      "Candidate separation is not an operating-system sandbox.",
      "External model, usage and workflow claims are adapter-reported, not independently verified.",
      "Process cleanup uses POSIX groups or Windows taskkill /T; independently detached processes require cooperative host shutdown.",
    ],
  };
  writeFileSync(join(directory, "manifest.json"), json(manifest), { flag: "wx" });
  const results: RunResult[] = [];
  const planned: Array<{
    task: ArenaTask;
    workflow: Workflow;
    result: RunResult;
    runDir: string;
    candidate: string;
    evidence: string;
  }> = [];
  for (const task of options.tasks)
    for (let trial = 1; trial <= trials; trial++)
      for (const workflow of selectedWorkflows) {
        const runId = `${task.id}-${workflow}-trial-${trial}`;
        const runDir = join(directory, "runs", runId);
        const candidate = join(runDir, "candidate");
        const evidence = join(runDir, "evidence");
        mkdirSync(runDir);
        mkdirSync(candidate);
        mkdirSync(evidence);
        const result: RunResult = {
          schemaVersion: 1,
          batchId,
          runId,
          trial,
          order: results.length + 1,
          task: { id: task.id, title: task.title, version: task.version },
          workflow,
          mode: options.adapter ? "external" : "scripted-control",
          control: options.adapter ? null : mode,
          adapter,
          status: "pending",
          startedAt: null,
          finishedAt: null,
          elapsedMs: null,
          adapterProcess: null,
          response: null,
          oracle: null,
          candidateCorrect: null,
          treatment: {
            status: "unverified",
            reasons: ["Execution has not produced trusted stage evidence."],
          },
          comparisonEligible: !options.adapter,
          oracleProcess: null,
          errors: [],
          finalFiles: null,
          provenance: {
            repositoryRevision: repoRevision,
            repositoryStatus: repoStatus,
            lockfileSha256: existsSync(lockPath) ? hash(readFileSync(lockPath)) : null,
            arenaSourceSha256: sourceHash,
            adapterSourceSha256: adapterSourceHash,
            adapterSourceCoverage: options.adapter ? "partial" : "complete-harness",
            adapterSourceLimitations: options.adapter
              ? [
                  "Only directly named absolute files are hashed. Relative wrapper files, imported dependencies, package installations, environment, remote services and model artifacts are not a complete dependency closure.",
                ]
              : [
                  "All arena source files are hashed; runtime and lockfile are recorded separately. No live framework adapter is invoked.",
                ],
            oracleCaseCount: task.oracleCaseCount,
            scorerProtocol: "separate-process-v1",
            candidateRestrictions: {
              profile: ["v1", "v2"].some((version) =>
                resolve(task.oracleFile).startsWith(join(arenaDir, "corpus", version) + sep),
              )
                ? "bundled-scorer-node-permission-readonly"
                : "custom-oracle-unverified",
              osSandbox: false,
              networkRestricted: false,
            },
            corpusSha256: "",
            starterSha256: "",
            oracleSha256: "",
            promptSha256: hash(json({ prompt: task.prompt, units: task.units })),
            configSha256: configHash,
            startingRevision: null,
            startingFiles: [],
            runtime: {
              node: process.version,
              platform: process.platform,
              arch: process.arch,
              release: release(),
              cpu: cpus()[0]?.model ?? null,
              parallelism: availableParallelism(),
              totalMemory: totalmem(),
            },
            limits,
          },
        };
        results.push(result);
        planned.push({ task, workflow, result, runDir, candidate, evidence });
        saveResult(runDir, result); // A requested cell exists before any task execution.
      }
  writeFileSync(join(directory, "report.md"), renderReport(results));
  for (const { task, workflow, result, runDir, candidate, evidence } of planned) {
    if (options.signal?.aborted) break;
    const runId = result.runId;
    result.status = "running";
    result.startedAt = new Date().toISOString();
    saveResult(runDir, result);
    const start = performance.now();
    try {
      const startingFiles = treeManifest(task.starterDir);
      result.provenance.startingFiles = startingFiles;
      result.provenance.starterSha256 = hash(json(startingFiles));
      result.provenance.oracleSha256 = hash(readFileSync(task.oracleFile));
      result.provenance.corpusSha256 = hash(
        json({
          task: {
            id: task.id,
            version: task.version,
            prompt: task.prompt,
            units: task.units,
            oracleCaseCount: task.oracleCaseCount,
          },
          startingFiles,
          solution: treeManifest(task.solutionDir),
          oracleSha256: result.provenance.oracleSha256,
        }),
      );
      copyStarter(task, candidate, startingFiles);
      git(["init", "--quiet", "--object-format=sha1", "--initial-branch=arena"], candidate);
      git(["add", "--all", "--force"], candidate);
      git(["commit", "--quiet", "--allow-empty", "-m", "arena starter"], candidate);
      result.provenance.startingRevision = git(["rev-parse", "HEAD"], candidate);
      const request: AdapterRequest = {
        deadlineAt: Date.now() + limits.timeoutMs,
        schemaVersion: 1,
        runId,
        task: { id: task.id, version: task.version, prompt: task.prompt, units: task.units },
        workflow,
        cwd: candidate,
        evidenceDir: evidence,
        startingRevision: result.provenance.startingRevision,
        model: adapter.model ?? null,
        limits: { timeoutMs: limits.timeoutMs, maxRepairs: limits.maxRepairs },
      };
      const requestFile = join(runDir, "request.json");
      writeFileSync(requestFile, json(request), { flag: "wx" });
      saveResult(runDir, result);
      let args = [...(adapter.args ?? []), requestFile];
      if (!options.adapter) {
        const workerInput = join(evidence, "offline-input.json");
        writeFileSync(workerInput, json({ request, task, mode }), { flag: "wx" });
        args = [workerFile, "--offline-worker", workerInput];
      }
      const adapterRun = await runProcess({
        signal: options.signal,
        command: adapter.command,
        args,
        cwd: candidate,
        timeoutMs: Math.max(1, request.deadlineAt! - Date.now()),
        maxLogBytes: limits.maxLogBytes,
        stdoutFile: join(evidence, "adapter.stdout.log"),
        stderrFile: join(evidence, "adapter.stderr.log"),
      });
      result.adapterProcess = summary(adapterRun);
      const adapterError = processError(adapterRun, "Adapter");
      if (adapterError) result.errors.push(adapterError);
      try {
        if (adapterRun.stdoutTruncated)
          throw new Error("Adapter stdout exceeded log cap; JSON was not parsed");
        result.response = parseAdapterResponse(adapterRun.stdout);
        writeFileSync(join(evidence, "adapter-response.json"), json(result.response), {
          flag: "wx",
        });
        if (result.response.status !== "completed") result.errors.push("Adapter reported failure");
        if (result.response.repairs !== null && result.response.repairs > limits.maxRepairs)
          result.errors.push("Adapter exceeded maxRepairs");
        if (options.adapter && adapter.model && json(adapter.model) !== json(result.response.model))
          result.errors.push("Reported model differs from requested model");
      } catch (error) {
        result.errors.push(errorText(error));
      }
      saveResult(runDir, result);
      if (options.signal?.aborted) throw new Error("Arena canceled by user");
      const candidateFiles = treeManifest(candidate);
      if (candidateFiles.some((file) => file.kind === "symlink"))
        throw new Error("Candidate symlink prohibited; oracle skipped");
      writeFileSync(join(evidence, "evaluated-snapshot.json"), json(candidateFiles), {
        flag: "wx",
      });
      const oracleRun = await runProcess({
        signal: options.signal,
        command: process.execPath,
        args: [task.oracleFile, candidate],
        cwd: dirname(task.oracleFile),
        timeoutMs: limits.oracleTimeoutMs,
        maxLogBytes: limits.maxLogBytes,
        stdoutFile: join(evidence, "oracle.stdout.log"),
        stderrFile: join(evidence, "oracle.stderr.log"),
        scoreFile: join(evidence, "oracle.score.json"),
        env: {
          ...process.env,
          ARENA_SCORE_FD: "3",
          ARENA_ORACLE_TIMEOUT_MS: String(limits.oracleTimeoutMs),
        },
      });
      result.oracleProcess = summary(oracleRun);
      let oracleCorrect: boolean | null = null;
      try {
        if (oracleRun.timedOut || oracleRun.error || oracleRun.scoreTruncated)
          throw new Error(
            processError(oracleRun, "Oracle") ?? "Oracle score channel exceeded log cap",
          );
        if (!oracleRun.score?.trim())
          throw new Error("Oracle produced no result on the trusted score channel");
        result.oracle = parseOracle(oracleRun.score, task.oracleCaseCount);
        if (oracleRun.code !== (result.oracle.passed === result.oracle.total ? 0 : 1))
          throw new Error("Oracle exit code disagrees with its result");
        oracleCorrect = result.oracle.passed === result.oracle.total;
        if (result.oracle.passed !== result.oracle.total)
          result.errors.push("Oracle correctness checks failed");
      } catch (error) {
        result.errors.push(errorText(error));
      }
      if (json(treeManifest(candidate)) !== json(candidateFiles)) {
        result.errors.push(
          "Candidate changed during oracle evaluation; correctness result is not attributable to a stable snapshot",
        );
      } else result.candidateCorrect = oracleCorrect;
    } catch (error) {
      result.errors.push(errorText(error));
    } finally {
      try {
        result.finalFiles = treeManifest(candidate);
        writeFileSync(join(evidence, "final-snapshot.json"), json(result.finalFiles), {
          flag: "wx",
        });
        if (result.provenance.startingRevision)
          writeFileSync(
            join(evidence, "final.diff"),
            git(
              [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                result.provenance.startingRevision,
                "--",
                ".",
              ],
              candidate,
            ),
            { flag: "wx" },
          );
      } catch (error) {
        result.candidateCorrect = null;
        result.errors.push(`Final snapshot: ${errorText(error)}`);
      }
      result.elapsedMs = performance.now() - start;
      result.finishedAt = new Date().toISOString();
      result.treatment = verifyTreatment({
        mode: result.mode,
        workflow,
        unitIds: task.units.map((unit) => unit.id),
        maxRepairs: limits.maxRepairs,
        response: result.response,
      });
      if (result.mode === "scripted-control" && result.treatment.status !== "verified-control")
        result.errors.push(
          "Scripted treatment verification failed: " + result.treatment.reasons.join("; "),
        );
      result.status = result.errors.length ? "failed" : "completed";
      saveResult(runDir, result);
      writeFileSync(join(directory, "report.md"), renderReport(results));
    }
  }
  return { directory, results };
}
