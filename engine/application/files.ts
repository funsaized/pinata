import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DomainError, type ArtifactRef } from "../contracts/common.ts";
import type { ArtifactPort } from "../contracts/backend.ts";
import { digestBytes, isMissing, syncDirectory, type FaultHook } from "../storage/io.ts";
import type { ApplicationChange, ApplicationFile } from "../contracts/application.ts";
import { isSecretPath } from "../workspace/paths.ts";

export function validateApplicationPath(path: string): void {
  const components = path.split("/");
  if (
    !path ||
    path.includes("\\") ||
    path.includes(":") ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    components.some(
      (component) =>
        !component ||
        component === "." ||
        component === ".." ||
        /[. ]$/.test(component) ||
        [".git", ".pinata"].includes(component.toLowerCase()) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component),
    )
  )
    throw new DomainError("invalid_input", `Unsafe application path: ${JSON.stringify(path)}`);
  if (
    isSecretPath(path) ||
    components.some((component) => {
      const name = component.toLowerCase();
      return (
        name === ".env" ||
        name.startsWith(".env.") ||
        ["auth.json", ".npmrc", ".netrc"].includes(name)
      );
    })
  )
    throw new DomainError(
      "capability_denied",
      `Application refuses secret-bearing path: ${JSON.stringify(path)}`,
    );
}

async function assertNoLinks(root: string, path: string): Promise<void> {
  let current = root;
  const components = path.split("/");
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new DomainError(
        "conflict",
        `Application path traverses a symlink or junction: ${path}`,
      );
    if (index < components.length - 1 && !stat.isDirectory())
      throw new DomainError("conflict", `Application parent is not a directory: ${path}`);
  }
}

export async function readApplicationFile(
  root: string,
  path: string,
): Promise<ApplicationFile | null> {
  validateApplicationPath(path);
  await assertNoLinks(root, path);
  let file;
  try {
    // A FIFO can replace an ordinary destination. Open without waiting for a
    // writer, then reject non-files before reading or taking application action.
    file = await open(
      join(root, path),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile())
      throw new DomainError("conflict", `Application target is not a regular file: ${path}`);
    const bytes = await file.readFile();
    const after = await file.stat();
    const current = await lstat(join(root, path));
    await assertNoLinks(root, path);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.isSymbolicLink()
    )
      throw new DomainError("conflict", `Application target changed while observed: ${path}`);
    return {
      mode: process.platform !== "win32" && (after.mode & 0o111) !== 0 ? "100755" : "100644",
      blob: { digest: digestBytes(bytes), size: bytes.length },
    };
  } finally {
    await file.close();
  }
}

export function sameFile(left: ApplicationFile | null, right: ApplicationFile | null): boolean {
  return left === null || right === null
    ? left === right
    : left.mode === right.mode &&
        left.blob.digest === right.blob.digest &&
        left.blob.size === right.blob.size;
}

export async function verifiedArtifact(
  artifacts: ArtifactPort,
  ref: ArtifactRef,
): Promise<Uint8Array> {
  const bytes = await artifacts.read(ref);
  if (bytes.length !== ref.size || digestBytes(bytes) !== ref.digest)
    throw new DomainError(
      "conflict",
      `Application artifact does not match its immutable reference: ${ref.digest}`,
    );
  return bytes;
}

async function syncParent(path: string, phase: string, fault?: FaultHook): Promise<void> {
  await fault?.(`${phase}.directory-sync.before`);
  await syncDirectory(dirname(path));
  await fault?.(`${phase}.directory-sync.after`);
}

export async function writeApplicationFile(options: {
  root: string;
  change: ApplicationChange;
  operationId: string;
  artifacts: ArtifactPort;
  assertRepository: () => Promise<void>;
  fault?: FaultHook;
  signal?: AbortSignal;
}): Promise<void> {
  const { root, change, operationId, artifacts, assertRepository, fault, signal } = options;
  const { path, before, after } = change;
  validateApplicationPath(path);
  signal?.throwIfAborted();
  const phase = `application.file.${path}`;
  const current = await readApplicationFile(root, path);
  if (!sameFile(current, before) && !sameFile(current, after))
    throw new DomainError("conflict", `Application recovery refuses later edits: ${path}`);
  const target = join(root, path);
  if (sameFile(current, after)) {
    await syncParent(target, phase, fault);
    return;
  }
  await assertRepository();
  if (!after) {
    signal?.throwIfAborted();
    await fault?.(`${phase}.unlink.before`);
    if (!sameFile(await readApplicationFile(root, path), before))
      throw new DomainError("conflict", `Application target changed before removal: ${path}`);
    await unlink(target);
    await fault?.(`${phase}.unlink.after`);
    await syncParent(target, phase, fault);
    return;
  }
  const bytes = await verifiedArtifact(artifacts, after.blob);
  let parent = root;
  for (const component of path.split("/").slice(0, -1)) {
    const directory = join(parent, component);
    await assertNoLinks(root, path);
    let exists = true;
    try {
      await lstat(directory);
    } catch (error) {
      if (!isMissing(error)) throw error;
      exists = false;
    }
    if (!exists) {
      await fault?.(`${phase}.mkdir.${component}.before`);
      await mkdir(directory);
      await fault?.(`${phase}.mkdir.${component}.after`);
      await fault?.(`${phase}.parent-sync.${component}.before`);
      await syncDirectory(parent);
      await fault?.(`${phase}.parent-sync.${component}.after`);
    }
    parent = directory;
  }
  await assertNoLinks(root, path);
  const stagingDirectory = join(root, ".pinata", "application-staging");
  await fault?.(`${phase}.staging-mkdir.before`);
  const metadataState = await lstat(join(root, ".pinata"));
  if (!metadataState.isDirectory() || metadataState.isSymbolicLink())
    throw new DomainError("conflict", "Application metadata must not traverse a link");
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  await fault?.(`${phase}.staging-mkdir.after`);
  await fault?.(`${phase}.staging-parent-sync.before`);
  await syncDirectory(dirname(stagingDirectory));
  await fault?.(`${phase}.staging-parent-sync.after`);
  const directoryState = await lstat(stagingDirectory);
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink())
    throw new DomainError("conflict", "Application staging must be a real directory");
  const staging = join(
    stagingDirectory,
    `${digestBytes(Buffer.from(operationId)).slice(0, 16)}-${randomUUID()}`,
  );
  await assertNoLinks(root, path);
  const staged = await open(staging, "wx", 0o600);
  try {
    await fault?.(`${phase}.write.before`);
    await staged.writeFile(bytes);
    await fault?.(`${phase}.write.after`);
    await fault?.(`${phase}.chmod.before`);
    await staged.chmod(after.mode === "100755" ? 0o755 : 0o644);
    await fault?.(`${phase}.chmod.after`);
    await fault?.(`${phase}.sync.before`);
    await staged.sync();
    await fault?.(`${phase}.sync.after`);
  } finally {
    await staged.close();
  }
  signal?.throwIfAborted();
  await assertRepository();
  await fault?.(`${phase}.rename.before`);
  if (!sameFile(await readApplicationFile(root, path), before))
    throw new DomainError("conflict", `Application target changed before replacement: ${path}`);
  await assertNoLinks(root, path);
  await rename(staging, target);
  await fault?.(`${phase}.rename.after`);
  await syncParent(target, phase, fault);
  await fault?.(`${phase}.staging-directory-sync.before`);
  await syncDirectory(stagingDirectory);
  await fault?.(`${phase}.staging-directory-sync.after`);
}
