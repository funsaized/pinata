import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, realpath, stat, statfs } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson } from "../engine/contracts/digest.ts";
import { replaceProjection, syncDirectory } from "../engine/storage/io.ts";
import { type BenchReport, type CellRecord, type CellSpec } from "./types.ts";

const executeFile = promisify(execFile);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export async function projectRoot(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      await access(join(directory, "package.json"));
      return directory;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) throw new Error("Benchmark package root is unavailable");
      directory = parent;
    }
  }
}
async function files(directory: string, prefix = ""): Promise<string[]> {
  const entries: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === "results") continue;
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) entries.push(...(await files(join(directory, item.name), path)));
    else if (item.isFile()) entries.push(path);
  }
  return entries.sort();
}
export async function sourceClosure(): Promise<{ digest: string; files: Record<string, string> }> {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const paths = [
    ...(await files(join(directory, "engine"))).map((path) => `engine/${path}`),
    ...(await files(join(directory, "bench"))).map((path) => `bench/${path}`),
  ];
  const observed = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, hash(await readFile(join(directory, path)))]),
    ),
  );
  return { digest: hash(canonicalJson(observed)), files: observed };
}
export async function resolveCommand(command: string): Promise<string> {
  if (command.includes("/") || command.includes("\\")) return realpath(command);
  const suffixes =
    process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD").split(";")] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter))
    for (const suffix of suffixes) {
      const path = join(directory, command + suffix);
      try {
        await access(path, constants.X_OK);
        return realpath(path);
      } catch {
        /* Continue to the next explicit PATH entry. */
      }
    }
  throw new Error(`Executable is unavailable: ${command}`);
}
export type PiLauncher = {
  path: string;
  command: string;
  args: string[];
  kind: "node-script" | "script" | "executable";
  shebang: string | null;
};
export async function resolvePiLauncher(pi: string, nodeCommand: string): Promise<PiLauncher> {
  const path = await resolveCommand(pi);
  const file = await open(path, "r");
  let firstLine: string;
  try {
    const prefix = Buffer.alloc(1024);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    firstLine = prefix.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
  } finally {
    await file.close();
  }
  const shebang = firstLine.startsWith("#!") ? firstLine : null;
  // Preserve arbitrary wrappers and shebang flags rather than guessing how to
  // reproduce their interpreter selection. Plain Node entrypoints are explicit.
  const nodeScript =
    /\.(?:c|m)?js$/.test(path) &&
    /^#![ \t]*(?:\/usr\/bin\/env[ \t]+node|\/(?:[^/\s]+\/)*node)[ \t]*$/.test(firstLine);
  return {
    path,
    command: nodeScript ? await resolveCommand(nodeCommand) : path,
    args: nodeScript ? ["--expose-gc", path] : [],
    kind: nodeScript ? "node-script" : shebang ? "script" : "executable",
    shebang,
  };
}
const darwinFilesystemSchema = z.object({
  "storage-system-information": z.object({
    filesystem: z.tuple([
      z.object({
        name: z.string().regex(/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/),
        type: z.string().regex(/^[a-z][a-z0-9_-]*$/),
        "mounted-on": z.string().startsWith("/"),
      }),
    ]),
  }),
});
export function parseDarwinFilesystem(stdout: string): {
  name: string;
  deviceNode: string;
  mountPoint: string;
} {
  const [filesystem] = darwinFilesystemSchema.parse(JSON.parse(stdout))[
    "storage-system-information"
  ].filesystem;
  return {
    name: filesystem.type,
    deviceNode: filesystem.name,
    mountPoint: filesystem["mounted-on"],
  };
}
type FilesystemNameEvidence =
  | {
      status: "observed";
      method: "darwin-df-libxo-v1";
      directory: string;
      device: string;
      name: string;
      deviceNode: string;
      mountPoint: string;
    }
  | { status: "unavailable"; reason: string };
async function darwinFilesystemName(
  directory: string,
  identity: { dev: bigint; ino: bigint },
): Promise<FilesystemNameEvidence> {
  try {
    // Apple's df -Y reads f_fstypename for the supplied path. Its structured
    // output avoids guessing the name from a dynamically allocated f_type.
    const { stdout } = await executeFile("/bin/df", ["--libxo", "json", "-P", "-Y", directory], {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    const filesystem = parseDarwinFilesystem(stdout);
    const [device, mount, after] = await Promise.all([
      stat(filesystem.deviceNode, { bigint: true }),
      stat(filesystem.mountPoint, { bigint: true }),
      stat(directory, { bigint: true }),
    ]);
    if (
      !device.isBlockDevice() ||
      device.rdev !== identity.dev ||
      !mount.isDirectory() ||
      mount.dev !== identity.dev ||
      !after.isDirectory() ||
      after.dev !== identity.dev ||
      after.ino !== identity.ino
    )
      throw new Error("Filesystem-name evidence differs from the allocated directory identity");
    return {
      status: "observed",
      method: "darwin-df-libxo-v1",
      directory,
      device: identity.dev.toString(),
      ...filesystem,
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
export type StorageProvenance =
  | {
      status: "observed";
      directory: string;
      filesystemType: string;
      blockSize: string;
      device: string;
      filesystemName?: FilesystemNameEvidence;
    }
  | { status: "unavailable"; directory: string; reason: string };
export async function storageProvenance(directory: string): Promise<StorageProvenance> {
  const canonical = await realpath(directory);
  try {
    const [filesystem, location] = await Promise.all([
      statfs(canonical, { bigint: true }),
      stat(canonical, { bigint: true }),
    ]);
    return {
      status: "observed",
      directory: canonical,
      filesystemType: `0x${filesystem.type.toString(16)}`,
      blockSize: filesystem.bsize.toString(),
      device: location.dev.toString(),
      ...(process.platform === "darwin"
        ? { filesystemName: await darwinFilesystemName(canonical, location) }
        : {}),
    };
  } catch (error) {
    return {
      status: "unavailable",
      directory: canonical,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
export async function provenance(
  root: string,
  options: {
    piLauncher?: PiLauncher;
    configuration: unknown;
    workloads: unknown;
    agentDir: string;
    storageDirectory: string;
  },
): Promise<Record<string, unknown>> {
  const git = async (args: string[]) => {
    try {
      return (
        await executeFile("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024 })
      ).stdout.trim();
    } catch {
      return "unavailable";
    }
  };
  let piLauncher: unknown = null;
  if (options.piLauncher) {
    const launch = options.piLauncher;
    const bytes = await readFile(launch.path);
    const version = await executeFile(launch.command, [...launch.args, "--version"], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: options.agentDir,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
      timeout: 10_000,
    });
    piLauncher = {
      path: launch.path,
      digest: hash(bytes),
      version: version.stdout.trim(),
      kind: launch.kind,
      shebang: launch.shebang,
      command: [launch.command, ...launch.args],
      interpreter:
        launch.kind === "node-script"
          ? {
              path: launch.command,
              node: (await executeFile(launch.command, ["--version"])).stdout.trim(),
              digest: hash(await readFile(launch.command)),
            }
          : null,
    };
  }
  return {
    platform: process.platform,
    architecture: process.arch,
    cpu: cpus().map((cpu) => cpu.model),
    memory: totalmem(),
    node: process.version,
    piLauncher,
    commit: await git(["rev-parse", "HEAD"]),
    dirty: await git(["status", "--porcelain=v1"]),
    lockfile: hash(await readFile(join(root, "package-lock.json"))),
    source: await sourceClosure(),
    storage: await storageProvenance(options.storageDirectory),
    configuration: options.configuration,
    workloads: hash(canonicalJson(options.workloads)),
  };
}
export async function reserveOutput(
  root: string,
  requested?: string,
): Promise<{ path: string; summary: string; directory: string }> {
  const path = resolve(
    requested ??
      join(
        root,
        "bench",
        "results",
        `runtime-v3-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`,
      ),
  );
  await mkdir(dirname(path), { recursive: true });
  const summary = path.replace(/\.json$/, "") + ".md";
  for (const candidate of [path, summary]) {
    const file = await open(candidate, "wx", 0o600);
    try {
      await file.writeFile(
        candidate === path
          ? '{"status":"allocated"}\n'
          : "Benchmark allocated; no result has completed.\n",
      );
      await file.sync();
    } finally {
      await file.close();
    }
  }
  await syncDirectory(dirname(path));
  const directory = path + ".cells";
  await mkdir(directory, { recursive: false });
  await syncDirectory(dirname(directory));
  return { path, summary, directory };
}
export async function allocateCell(
  directory: string,
  spec: Omit<CellSpec, "cellId" | "directory" | "output">,
): Promise<{ spec: CellSpec; record: CellRecord }> {
  const cellId = randomUUID();
  const cellDirectory = join(directory, cellId);
  await mkdir(cellDirectory);
  const complete: CellSpec = {
    ...spec,
    cellId,
    directory: await realpath(cellDirectory),
    output: join(await realpath(cellDirectory), "result.json"),
  };
  const file = await open(join(cellDirectory, "spec.json"), "wx", 0o600);
  try {
    await file.writeFile(canonicalJson(complete));
    await file.sync();
  } finally {
    await file.close();
  }
  const record: CellRecord = {
    cellId,
    scenario: spec.scenario.name,
    attempt: spec.attempt,
    state: "allocated",
    directory: complete.directory,
    performanceFailures: [],
    executionFailures: [],
  };
  await checkpointCell(record);
  await syncDirectory(cellDirectory);
  await syncDirectory(directory);
  return { spec: complete, record };
}
export async function checkpointCell(record: CellRecord): Promise<void> {
  await replaceProjection(
    join(record.directory, "status.json"),
    Buffer.from(canonicalJson(record)),
    "benchmark-status",
  );
}
export async function publishReport(
  path: string,
  summaryPath: string,
  report: BenchReport,
): Promise<void> {
  await replaceProjection(
    path,
    Buffer.from(JSON.stringify(report, null, 2) + "\n"),
    "benchmark-report",
  );
  const rows = report.cells.map(
    (cell) =>
      `| ${cell.scenario} | ${cell.attempt} | ${cell.state} | ${cell.result?.status ?? "unavailable"} | ${cell.result?.spawnMs?.p50.toFixed(3) ?? "—"} | ${cell.result?.assignments ?? "—"} | ${[...cell.executionFailures, ...cell.performanceFailures].join("; ") || cell.error || ""} |`,
  );
  const text = `# Scripted runtime benchmark\n\nStatus: ${report.status}. This measures local orchestration overhead, not model coding quality. Every allocated attempt is retained.\n\nBudget profile: ${report.budgetProfile}; tolerance factor: ${report.budgetFactor}×. Exact base limits are retained in the JSON report.\n\n| Scenario | Attempt | State | Execution | Spawn p50 ms | Assignments | Findings |\n| --- | ---: | --- | --- | ---: | ---: | --- |\n${rows.join("\n")}\n\nIn-process budgets use the preserved 2× tolerance. Process/Herdr timing is advisory. The JSON report contains source closure, complete measurements, usage coverage and cleanup evidence. Render requests do not establish painted frames.\n`;
  await replaceProjection(summaryPath, Buffer.from(text), "benchmark-summary");
}
export async function readReport(
  path: string,
): Promise<{ format: "runtime-v3" | "historical"; comparable: boolean; report: unknown }> {
  const report: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!report || typeof report !== "object") throw new Error("Benchmark report must be an object");
  if (
    "schemaVersion" in report &&
    report.schemaVersion === 3 &&
    "measurement" in report &&
    report.measurement === "pinata-scripted-runtime-v3"
  )
    return { format: "runtime-v3", comparable: true, report };
  if ("schemaVersion" in report && (report.schemaVersion === 1 || report.schemaVersion === 2))
    return { format: "historical", comparable: false, report };
  throw new Error("Unsupported benchmark report version");
}
