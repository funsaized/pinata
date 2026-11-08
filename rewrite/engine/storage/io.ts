import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type FaultHook = (point: string) => void | Promise<void>;

export class StorageError extends Error {
  readonly code: "conflict" | "owner_unconfirmed" | "commit_unknown";

  constructor(code: StorageError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose directory fsync through Node. File FlushFileBuffers still
  // applies; power-loss durability of directory entries is not asserted there.
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeSynced(
  path: string,
  bytes: Uint8Array,
  phase: string,
  fault?: FaultHook,
): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await fault?.(`${phase}.write.before`);
    await file.writeFile(bytes);
    await fault?.(`${phase}.write.after`);
    await fault?.(`${phase}.sync.before`);
    await file.sync();
    await fault?.(`${phase}.sync.after`);
  } finally {
    await file.close();
  }
}

export async function publishImmutable(
  path: string,
  bytes: Uint8Array,
  phase: string,
  fault?: FaultHook,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await readOptional(path);
  if (existing) {
    if (!existing.equals(bytes))
      throw new StorageError("conflict", `Immutable bytes differ: ${path}`);
    const file = await open(path, "r");
    try {
      await fault?.(`${phase}.sync.before`);
      await file.sync();
      await fault?.(`${phase}.sync.after`);
    } finally {
      await file.close();
    }
    await fault?.(`${phase}.directory-sync.before`);
    await syncDirectory(directory);
    await fault?.(`${phase}.directory-sync.after`);
    return;
  }
  const staged = join(directory, `.unaccepted-${randomUUID()}`);
  await writeSynced(staged, bytes, phase, fault);
  await fault?.(`${phase}.publish.before`);
  // A hard link publishes atomically without replacing an existing artifact. Failed
  // staging remains inspectable; an orphan never authorizes execution.
  try {
    await link(staged, path);
  } catch (error) {
    if (!isExisting(error)) throw error;
    if (!(await readFile(path)).equals(bytes))
      throw new StorageError("conflict", `Immutable bytes differ: ${path}`);
  }
  await fault?.(`${phase}.publish.after`);
  await fault?.(`${phase}.directory-sync.before`);
  await syncDirectory(directory);
  await fault?.(`${phase}.directory-sync.after`);
  await unlink(staged);
}

export async function replaceProjection(
  path: string,
  bytes: Uint8Array,
  phase: string,
  fault?: FaultHook,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = join(dirname(path), `.projection-${randomUUID()}`);
  await writeSynced(staged, bytes, phase, fault);
  await fault?.(`${phase}.publish.before`);
  await rename(staged, path);
  await fault?.(`${phase}.publish.after`);
  await fault?.(`${phase}.directory-sync.before`);
  await syncDirectory(dirname(path));
  await fault?.(`${phase}.directory-sync.after`);
}
