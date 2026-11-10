import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  artifactRefSchema,
  assignmentRefSchema,
  digestSchema,
  identitySchema,
  canonicalJson,
  digestValue,
  DomainError,
  type ArtifactPort,
  type ArtifactRef,
  type AssignmentRef,
} from "../contracts/index.ts";
import {
  digestBytes,
  isExisting,
  isMissing,
  publishImmutable,
  syncDirectory,
  type FaultHook,
} from "../storage/io.ts";
import { GitCommands, nulPaths } from "./git.ts";
import { canonicalWorkspace, validateManifestPath, workspacePath } from "./paths.ts";

const maxFiles = 1000;
const maxFileBytes = 16 * 1024 * 1024;
const pathSchema = z
  .string()
  .min(1)
  .refine((path) => validateManifestPath(path) === null);
const includedFileSchema = z.strictObject({
  path: pathSchema,
  digest: digestSchema,
  size: z.number().int().min(0).max(maxFileBytes),
  mode: z.number().int().min(0).max(0o777),
});
export const includedFilesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.string().min(1),
  patternsDigest: digestSchema,
  files: z.array(includedFileSchema).max(maxFiles),
  omitted: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
});
export type IncludedFiles = z.infer<typeof includedFilesSchema>;
const includeIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ref: assignmentRefSchema,
  ownerEpoch: identitySchema,
  source: z.string().min(1),
  destination: z.string().min(1),
  selection: artifactRefSchema,
});
export type IncludeIntent = z.infer<typeof includeIntentSchema>;

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function regular(path: string): Promise<{ bytes: Buffer; mode: number }> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new DomainError(
      "capability_denied",
      "Included source must be a regular file without links",
    );
  if (before.size > BigInt(maxFileBytes))
    throw new DomainError("unsupported", "Included file exceeds 16 MiB");
  const file = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened))
      throw new DomainError("conflict", "Included file identity changed before reading");
    const bytes = await file.readFile();
    if (
      !sameFile(before, await file.stat({ bigint: true })) ||
      !sameFile(before, await lstat(path, { bigint: true })) ||
      BigInt(bytes.length) !== before.size
    )
      throw new DomainError("conflict", "Included file changed during its observation");
    return { bytes, mode: Number(before.mode & 0o777n) };
  } finally {
    await file.close();
  }
}

async function ignored(
  root: string,
  paths: string[],
  git: GitCommands,
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const result = await git.run(root, ["check-ignore", "-z", "--stdin"], {
    input: paths.join("\0") + "\0",
    // check-ignore consumes literal filenames, not Git pathspecs, and rejects
    // the otherwise useful global literal-pathspec mode.
    env: { GIT_LITERAL_PATHSPECS: "0" },
    allowFailure: true,
    signal,
  });
  if (result.code !== 0 && result.code !== 1)
    throw new DomainError(
      "context_unavailable",
      "Cannot confirm .worktreeinclude files are ignored",
    );
  return new Set(nulPaths(result.stdout));
}

// Explicitly included files can contain local credentials. Retain only their
// selection and byte identities, never their contents in the artifact store.
export async function freezeIncluded(
  root: string,
  git: GitCommands,
  artifacts: ArtifactPort,
  signal?: AbortSignal,
): Promise<ArtifactRef | undefined> {
  let patterns: Buffer;
  try {
    patterns = (await regular(await workspacePath(root, ".worktreeinclude"))).bytes;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const patternsPath = join(git.directory, "include-patterns");
  await publishImmutable(patternsPath, patterns, "include-patterns");
  const matches = nulPaths(
    (
      await git.run(
        root,
        ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${patternsPath}`],
        { signal },
      )
    ).stdout,
  );
  const ignoredPaths = await ignored(root, matches, git, signal);
  if (ignoredPaths.size > maxFiles)
    throw new DomainError(
      "invalid_input",
      ".worktreeinclude selects more than 1000 files; narrow its patterns",
    );
  const files: IncludedFiles["files"] = [];
  const omitted: IncludedFiles["omitted"] = [];
  for (const path of [...new Set(matches)].sort()) {
    signal?.throwIfAborted();
    if (!ignoredPaths.has(path)) {
      omitted.push({ path, reason: "Not ignored in the source checkout" });
      continue;
    }
    try {
      const content = await regular(await workspacePath(root, path));
      files.push({
        path,
        digest: digestBytes(content.bytes),
        size: content.bytes.length,
        mode: content.mode,
      });
    } catch (error) {
      if (!(error instanceof DomainError) && !isMissing(error)) throw error;
      if (error instanceof DomainError && error.code === "conflict") throw error;
      omitted.push({ path, reason: error instanceof Error ? error.message : "Source unavailable" });
    }
  }
  const observation = includedFilesSchema.parse({
    schemaVersion: 1,
    source: root,
    patternsDigest: digestBytes(patterns),
    files,
    omitted,
  });
  return artifacts.put(Buffer.from(canonicalJson(observation)));
}

async function readArtifact(reference: ArtifactRef, artifacts: ArtifactPort): Promise<Buffer> {
  const bytes = await artifacts.read(reference);
  if (bytes.length !== reference.size || digestBytes(bytes) !== reference.digest)
    throw new DomainError("conflict", "Included-file evidence integrity failure");
  return Buffer.from(bytes);
}

export async function readIncluded(
  reference: ArtifactRef,
  source: string,
  artifacts: ArtifactPort,
): Promise<IncludedFiles> {
  const selection = includedFilesSchema.parse(
    JSON.parse((await readArtifact(reference, artifacts)).toString()),
  );
  if (
    selection.source !== source ||
    new Set(selection.files.map((file) => file.path)).size !== selection.files.length
  )
    throw new DomainError(
      "conflict",
      "Included-file observation differs from its source or repeats a path",
    );
  return selection;
}

export async function includeIntent(
  options: Omit<IncludeIntent, "schemaVersion">,
  artifacts: ArtifactPort,
): Promise<{ value: IncludeIntent; artifact: ArtifactRef }> {
  const value = includeIntentSchema.parse({ schemaVersion: 1, ...options });
  await readIncluded(value.selection, value.source, artifacts);
  return { value, artifact: await artifacts.put(Buffer.from(canonicalJson(value))) };
}

async function stagingDirectory(destination: string, ref: AssignmentRef): Promise<string> {
  let current = destination;
  for (const segment of [".pinata", "include-staging", digestValue(ref)]) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isExisting(error)) throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new DomainError("capability_denied", "Included-file staging cannot traverse links");
  }
  return current;
}

export async function copyIncluded(
  intent: IncludeIntent,
  git: GitCommands,
  artifacts: ArtifactPort,
  options: { signal: AbortSignal; fault?: FaultHook },
): Promise<ArtifactRef> {
  const selection = await readIncluded(intent.selection, intent.source, artifacts);
  if (
    (await canonicalWorkspace(intent.source)) !== intent.source ||
    (await canonicalWorkspace(intent.destination)) !== intent.destination
  )
    throw new DomainError(
      "conflict",
      "Included-file source or destination now resolves through a different alias",
    );
  const ignoredPaths = await ignored(
    intent.destination,
    selection.files.map((file) => file.path),
    git,
    options.signal,
  );
  const observations: Array<{ path: string; state: string }> = [];
  for (const entry of selection.files) {
    options.signal.throwIfAborted();
    if (!ignoredPaths.has(entry.path)) {
      observations.push({ path: entry.path, state: "not_ignored" });
      continue;
    }
    await options.fault?.(`workspace.include.${entry.path}.read.before`);
    const source = await regular(await workspacePath(intent.source, entry.path));
    if (
      source.bytes.length !== entry.size ||
      source.mode !== entry.mode ||
      digestBytes(source.bytes) !== entry.digest
    )
      throw new DomainError("conflict", `Included source changed after acceptance: ${entry.path}`);
    const destination = await workspacePath(intent.destination, entry.path);
    try {
      await lstat(destination);
      observations.push({ path: entry.path, state: "preserved_existing" });
      continue;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await workspacePath(intent.destination, entry.path);
    const staging = await stagingDirectory(intent.destination, intent.ref);
    const staged = join(staging, digestValue(entry.path));
    const file = await open(staged, "wx", 0o600);
    try {
      await file.writeFile(source.bytes);
      await file.chmod(entry.mode);
      await file.sync();
    } finally {
      await file.close();
    }
    await options.fault?.(`workspace.include.${entry.path}.publish.before`);
    await workspacePath(intent.destination, entry.path);
    try {
      await link(staged, destination);
      await syncDirectory(dirname(destination));
      observations.push({ path: entry.path, state: "copied" });
    } catch (error) {
      if (!isExisting(error)) throw error;
      observations.push({ path: entry.path, state: "preserved_existing" });
    }
    await options.fault?.(`workspace.include.${entry.path}.publish.after`);
    await unlink(staged);
    await syncDirectory(staging);
  }
  return artifacts.put(
    Buffer.from(
      canonicalJson({
        schemaVersion: 1,
        kind: "included-files-observed",
        intent: digestValue(intent),
        observations,
      }),
    ),
  );
}

// Recovery observes partial copies only. It never refreshes, overwrites or
// redispatches them, and never imports local credential contents as artifacts.
export async function observeIncluded(
  reference: ArtifactRef,
  expected: Omit<IncludeIntent, "schemaVersion">,
  artifacts: ArtifactPort,
): Promise<ArtifactRef> {
  const intent = includeIntentSchema.parse(
    JSON.parse((await readArtifact(reference, artifacts)).toString()),
  );
  const { schemaVersion: _version, ...identity } = intent;
  if (digestValue(identity) !== digestValue(expected))
    throw new DomainError("conflict", "Included-file intent differs from its workspace operation");
  const selection = await readIncluded(intent.selection, intent.source, artifacts);
  const observations: Array<{ path: string; state: string; digest?: string }> = [];
  for (const entry of selection.files) {
    try {
      const file = await regular(await workspacePath(intent.destination, entry.path));
      const digest = digestBytes(file.bytes);
      observations.push({
        path: entry.path,
        state:
          digest === entry.digest && file.mode === entry.mode
            ? "matches_source"
            : "changed_preserved",
        digest,
      });
    } catch (error) {
      if (isMissing(error)) observations.push({ path: entry.path, state: "absent" });
      else if (error instanceof DomainError)
        observations.push({ path: entry.path, state: "unsafe_or_changed_preserved" });
      else throw error;
    }
  }
  return artifacts.put(
    Buffer.from(
      canonicalJson({
        schemaVersion: 1,
        kind: "included-files-recovered",
        intent: reference,
        observations,
      }),
    ),
  );
}
