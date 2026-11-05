// Shared evidence storage. Reserve both files before starting a workload so a typo
// in --out cannot destroy an earlier run (or waste a long benchmark).
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { piCommand } from "../test/engine/pi-smoke.ts";

export interface ProvenanceOptions {
  kind: "engine" | "viewer" | "process";
  provider: string;
  host: string;
  backend: string;
  mode: string;
  tokenDelayMs?: number;
  scenarios: string[];
  workload?: unknown;
  argv?: string[];
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function version(argv: string[]) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim().split("\n")[0] : "unavailable";
}

export async function collectProvenance(root: string, options: ProvenanceOptions) {
  const { workload, ...identity } = options;
  const startedAt = new Date().toISOString();
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout : null;
  };
  const status = git("status", "--porcelain", "--untracked-files=normal");
  const diff = git("diff", "--binary", "HEAD", "--");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
  const files: Array<[string, string | null]> = [];
  for (const path of (untracked ?? "").split("\0").filter(Boolean).sort())
    files.push([path, await readFile(join(root, path)).then(sha256, () => null)]);
  const lock = await readFile(join(root, "package-lock.json")).catch(() => null);
  const cpu = cpus();
  return {
    ...identity,
    date: startedAt.slice(0, 10),
    startedAt,
    runId: randomUUID(),
    source: {
      commit: git("rev-parse", "--verify", "HEAD")?.trim() ?? null,
      branch: git("branch", "--show-current")?.trim() ?? null,
      dirty: status === null ? null : status.length > 0,
      lockfileSha256: lock ? sha256(lock) : null,
      // Includes tracked edits and content hashes of untracked, non-ignored files.
      // File contents and environment secrets are never included in the report.
      workingTreeSha256:
        status !== null && diff !== null && untracked !== null && files.every(([, hash]) => hash)
          ? sha256(JSON.stringify({ status, diff, files }))
          : null,
    },
    os: platform(),
    release: release(),
    arch: arch(),
    cpus: cpu.length,
    memoryGB: Math.round(totalmem() / 1073741824),
    machine: { hostname: hostname(), cpuModel: cpu[0]?.model ?? null, memoryBytes: totalmem() },
    node: process.version,
    v8: process.versions.v8,
    executable: process.execPath,
    pi: version([...piCommand(), "--version"]),
    piCommand: piCommand(),
    runnerGcExposed: typeof globalThis.gc === "function",
    instrumentation: {
      gc: !process.env.BENCH_NO_GC,
      sampler: !process.env.BENCH_NO_SAMPLER,
      loopLag: !process.env.BENCH_NO_LAG,
      trace: Boolean(process.env.BENCH_TRACE),
    },
    workloadSha256: sha256(JSON.stringify(workload ?? options.scenarios)),
    ciRun: {
      provider: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      job: process.env.GITHUB_JOB ?? null,
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
    },
  };
}

export type ReportMeta = Awaited<ReturnType<typeof collectProvenance>>;

const filenamePart = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "-");

export function reportFilename(meta: ReportMeta): string {
  return (
    [
      meta.kind,
      meta.source.commit?.slice(0, 12) ?? "unknown-commit",
      `${meta.os}-${meta.arch}`,
      `node-${meta.node}`,
      meta.host,
      meta.backend,
      meta.provider,
      meta.mode,
      meta.startedAt,
      meta.runId,
    ]
      .map(filenamePart)
      .join("_") + ".json"
  );
}

export async function reserveReport(root: string, meta: ReportMeta, out?: string) {
  const path = resolve(out ?? join(root, "bench", "results", reportFilename(meta)));
  const summaryPath = /\.json$/i.test(path) ? path.replace(/\.json$/i, ".md") : `${path}.md`;
  await mkdir(dirname(path), { recursive: true });
  const json = await open(path, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error(`Refusing to overwrite benchmark report: ${path}`);
    throw error;
  });
  let summary;
  try {
    summary = await open(summaryPath, "wx");
  } catch (error) {
    await json.close();
    await unlink(path);
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Refusing to overwrite benchmark summary: ${summaryPath}`);
    throw error;
  }
  await Promise.all([json.close(), summary.close()]);
  let closed = false;
  return {
    path,
    summaryPath,
    async write(report: unknown, markdown?: string) {
      if (closed) throw new Error("Benchmark report is closed");
      const data = JSON.stringify(report, null, 2) + "\n";
      await replace(path, data);
      if (markdown !== undefined) {
        await replace(summaryPath, markdown);
      }
    },
    async close() {
      closed = true;
    },
  };
}

async function replace(path: string, text: string) {
  // Each checkpoint replaces only this run's reserved file. A killed writer
  // leaves the previous complete checkpoint, never a half-written JSON document.
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function field(value: unknown, path: string): unknown {
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

// This is a compatibility check, not a statistical test or a regression gate.
// Revisions may differ intentionally. Runtime, workload and hardware must match.
export function comparisonIssues(left: unknown, right: unknown): string[] {
  const issues: string[] = [];
  for (const path of [
    "kind",
    "os",
    "release",
    "arch",
    "cpus",
    "memoryGB",
    "machine.cpuModel",
    "machine.memoryBytes",
    "node",
    "v8",
    "pi",
    "provider",
    "host",
    "backend",
    "mode",
    "runnerGcExposed",
    "instrumentation",
    "workloadSha256",
    "scenarios",
    "source.lockfileSha256",
  ]) {
    const a = field(left, path);
    const b = field(right, path);
    if (
      a === undefined ||
      a === null ||
      a === "unavailable" ||
      b === undefined ||
      b === null ||
      b === "unavailable"
    )
      issues.push(`${path} is unknown`);
    else if (JSON.stringify(a) !== JSON.stringify(b)) issues.push(`${path} differs`);
  }
  if (field(left, "tokenDelayMs") !== field(right, "tokenDelayMs"))
    issues.push("tokenDelayMs differs");
  if ([left, right].some((meta) => field(meta, "ciRun.provider") === "github-actions")) {
    for (const path of ["ciRun.provider", "ciRun.imageOS", "ciRun.imageVersion"]) {
      const a = field(left, path);
      const b = field(right, path);
      if (!a || !b) issues.push(`${path} is unknown`);
      else if (a !== b) issues.push(`${path} differs`);
    }
  }
  for (const [label, meta] of [
    ["current", left],
    ["baseline", right],
  ] as const)
    if (
      !field(meta, "source.commit") ||
      typeof field(meta, "source.dirty") !== "boolean" ||
      !field(meta, "source.workingTreeSha256")
    )
      issues.push(`${label} source identity is incomplete`);
  return issues;
}

const cell = (value: unknown) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");

export function reportSummary(
  meta: ReportMeta,
  details: {
    title: string;
    status: string;
    policy: string;
    columns: string[];
    rows: unknown[][];
    failures?: string[];
  },
): string {
  return [
    `# ${details.title}: ${details.status}`,
    "",
    `Run: ${meta.runId} · ${meta.startedAt}`,
    `Source: ${meta.source.commit ?? "unknown"} (${meta.source.dirty === null ? "unknown tree state" : meta.source.dirty ? "dirty" : "clean"})`,
    `Environment: ${meta.os}/${meta.arch}, Node ${meta.node}, Pi ${meta.pi}; host ${meta.host}, backend ${meta.backend}, provider ${meta.provider}, mode ${meta.mode}.`,
    "",
    details.policy,
    "",
    `| ${details.columns.map(cell).join(" | ")} |`,
    `| ${details.columns.map(() => "---").join(" | ")} |`,
    ...details.rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
    ...(details.failures?.length
      ? ["Failures:", "", ...details.failures.map((failure) => `- ${cell(failure)}`), ""]
      : []),
    "Raw measurements, attempts, validation, and full provenance are in the companion JSON report.",
    "",
  ].join("\n");
}
