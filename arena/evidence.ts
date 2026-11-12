import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalJson } from "../engine/contracts/digest.ts";
import { digestBytes, isMissing, publishImmutable } from "../engine/storage/io.ts";
import {
  artifactSchema,
  snapshotSchema,
  sourceSchema,
  type Artifact,
  type Snapshot,
  type Source,
} from "./contracts.ts";

const execute = promisify(execFile);
export class EvidenceStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async put(bytes: Uint8Array): Promise<Artifact> {
    const ref = { digest: digestBytes(bytes), bytes: bytes.byteLength };
    await publishImmutable(join(this.directory, ref.digest), bytes, "arena.artifact");
    return ref;
  }
  async json(value: unknown): Promise<Artifact> {
    return this.put(Buffer.from(canonicalJson(value)));
  }
  async read(value: Artifact): Promise<Buffer> {
    const ref = artifactSchema.parse(value);
    if (
      (await lstat(this.directory)).isSymbolicLink() ||
      (await realpath(this.directory)) !== resolve(this.directory)
    )
      throw new Error("Artifact directory must be canonical");
    const bytes = await regularBytes(join(this.directory, ref.digest));
    if (bytes.length !== ref.bytes || digestBytes(bytes) !== ref.digest)
      throw new Error(`Artifact integrity failure: ${ref.digest}`);
    return bytes;
  }
}

export async function regularBytes(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`Expected regular file: ${path}`);
  const handle = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error(`File identity changed: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      bytes.length !== after.size
    )
      throw new Error(`File changed during capture: ${path}`);
    return bytes;
  } finally {
    await handle.close();
  }
}
export function candidatePath(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (
    isAbsolute(path) ||
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "." || part === ".." || !part)
  )
    throw new Error(`Invalid candidate path: ${path}`);
  return target;
}
export async function captureTree(
  root: string,
  store: EvidenceStore,
  options: {
    boundary: Snapshot["boundary"];
    elapsedMs: number;
    exclude?: (path: string) => boolean;
  },
): Promise<{ ref: Artifact; snapshot: Snapshot }> {
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== resolve(root))
    throw new Error("Snapshot root must be canonical and cannot be a symlink");
  const start = performance.now();
  let files: Snapshot["files"] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === ".git" || options.exclude?.(path)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link in snapshot: ${path}`);
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else if (entry.isFile()) {
        const stat = await lstat(join(directory, entry.name));
        const artifact = await store.put(await regularBytes(join(directory, entry.name)));
        files.push({ path, mode: stat.mode & 0o777, artifact });
      } else throw new Error(`Special file in snapshot: ${path}`);
    }
  };
  await walk(root, "");
  const first = canonicalJson(files);
  files = [];
  await walk(root, "");
  if (canonicalJson(files) !== first) throw new Error("Snapshot changed during capture");
  const snapshot = snapshotSchema.parse({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    elapsedMs: options.elapsedMs,
    captureMs: performance.now() - start,
    boundary: options.boundary,
    files,
  });
  return { ref: await store.json(snapshot), snapshot };
}
export async function materializeSnapshot(
  snapshot: Snapshot,
  store: EvidenceStore,
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  for (const file of snapshotSchema.parse(snapshot).files) {
    const path = candidatePath(directory, file.path);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "wx", file.mode);
    try {
      await handle.writeFile(await store.read(file.artifact));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function captureSource(root: string, store: EvidenceStore): Promise<Source> {
  const limitations: string[] = [];
  const sourceRoots = [
    "engine",
    "arena",
    "bench",
    "bin",
    "agents",
    "prompts",
    "skills",
    "scripts",
    "examples",
    "test/engine",
    "test/readiness",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ];
  let revision: string | null = null;
  let diff: Artifact | null = null;
  try {
    revision = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    diff = await store.put(
      Buffer.from(
        (
          await execute(
            "git",
            [
              "diff",
              "--binary",
              "HEAD",
              "--",
              ...sourceRoots,
              ":(exclude)arena/local/**",
              ":(exclude)arena/results/**",
              ":(exclude)bench/results/**",
            ],
            {
              cwd: root,
              maxBuffer: 64 * 1024 * 1024,
            },
          )
        ).stdout,
      ),
    );
  } catch {
    limitations.push("Git revision or diff unavailable");
  }
  // Source roots are explicit. Credentials, result directories and unrelated sessions
  // are never swept into a published source archive.
  const paths = sourceRoots;
  const files: Snapshot["files"] = [];
  for (const path of paths) {
    try {
      const full = join(root, path);
      if ((await lstat(full)).isDirectory()) {
        const captured = await captureTree(full, store, {
          boundary: "starter",
          elapsedMs: 0,
          exclude: (name) =>
            /(^|\/)(node_modules|results|local|\.git|\.pinata|\.env(?:\..*)?|auth\.json|credentials[^/]*)($|\/)/.test(
              name,
            ),
        });
        files.push(
          ...captured.snapshot.files.map((file) => ({ ...file, path: `${path}/${file.path}` })),
        );
      } else
        files.push({
          path,
          mode: (await lstat(full)).mode & 0o777,
          artifact: await store.put(await regularBytes(full)),
        });
    } catch (error) {
      if (!isMissing(error)) throw error;
      limitations.push(`Source path unavailable: ${path}`);
    }
  }
  const lockfile = files.find((file) => file.path === "package-lock.json")?.artifact ?? null;
  let pi: string | null = null;
  try {
    pi = JSON.parse(
      await readFile(
        join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"),
        "utf8",
      ),
    ).version;
  } catch {
    limitations.push("Installed Pi version unavailable");
  }
  limitations.push(
    "Closure covers declared runtime/harness/corpus roots, including untracked files; external adapter imports and installed dependency bytes are not fully captured",
  );
  return sourceSchema.parse({
    schemaVersion: 1,
    revision,
    diff,
    lockfile,
    closure: await store.json({ schemaVersion: 1, roots: paths, files }),
    dependencyCoverage: "partial",
    limitations,
    node: process.version,
    pi,
    platform: process.platform,
    architecture: process.arch,
    machine: { cpus: cpus().length, memory: totalmem(), load: loadavg() },
  });
}
