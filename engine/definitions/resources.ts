import { chmod, lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { DomainError, type ArtifactRef } from "../contracts/common.ts";
import { type ArtifactPort } from "../contracts/backend.ts";
import { digestValue } from "../contracts/digest.ts";
import {
  frozenSkillSchema,
  loadoutSchema,
  type FrozenLoadout,
  type FrozenSkill,
} from "../contracts/loadout.ts";
import { digestBytes, isExisting, publishImmutable, syncDirectory } from "../storage/io.ts";
import { validateManifestPath } from "../workspace/paths.ts";

async function resource(path: string): Promise<{ bytes: Buffer; executable: boolean }> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new DomainError(
      "invalid_input",
      `Selected resource must be a regular file: ${path}`,
      "skills",
    );
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(path, flags);
  try {
    const opened = await file.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile())
      throw new DomainError("conflict", `Selected resource changed while opening: ${path}`);
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new DomainError("conflict", `Selected resource changed while reading: ${path}`);
    return { bytes, executable: (before.mode & 0o111n) !== 0n };
  } finally {
    await file.close();
  }
}

export async function freezeSkills(
  paths: readonly string[],
  options: { cwd: string; agentDir: string; artifacts: Pick<ArtifactPort, "put"> },
): Promise<FrozenSkill[]> {
  const frozen: FrozenSkill[] = [];
  const names = new Set<string>();
  for (const selected of paths) {
    const resolved = await realpath(resolve(options.cwd, selected));
    const sourcePath = (await lstat(resolved)).isDirectory()
      ? await realpath(join(resolved, "SKILL.md"))
      : resolved;
    const root = dirname(sourcePath);
    const initial = await resource(sourcePath);
    const loaded = loadSkills({
      cwd: options.cwd,
      agentDir: options.agentDir,
      skillPaths: [sourcePath],
      includeDefaults: false,
    });
    if (loaded.diagnostics.length || loaded.skills.length !== 1)
      throw new DomainError(
        "invalid_input",
        `${sourcePath}: ${loaded.diagnostics.map((diagnostic) => diagnostic.message).join("; ") || "Expected one explicit skill"}`,
        "pinata.skills",
      );
    const skill = loaded.skills[0];
    if (names.has(skill.name))
      throw new DomainError(
        "conflict",
        `Duplicate selected skill name: ${skill.name}`,
        "pinata.skills",
      );
    names.add(skill.name);
    const files: FrozenSkill["files"] = [];
    const visit = async (path: string): Promise<void> => {
      const relativePath = relative(root, path).split("\\").join("/");
      if (validateManifestPath(relativePath))
        throw new DomainError(
          "invalid_input",
          `Unsafe selected skill resource: ${relativePath}`,
          "pinata.skills",
        );
      const state = await lstat(path);
      if (state.isSymbolicLink())
        throw new DomainError(
          "capability_denied",
          `Selected skill resource traverses a link: ${path}`,
          "pinata.skills",
        );
      if (state.isDirectory()) {
        for (const name of (await readdir(path)).sort()) {
          if (name === ".git" || name === ".pinata") continue;
          await visit(join(path, name));
        }
        return;
      }
      const content = await resource(path);
      files.push({
        path: relativePath,
        artifact: await options.artifacts.put(content.bytes),
        executable: content.executable,
      });
    };
    if (basename(sourcePath).toLowerCase() === "skill.md") {
      for (const name of (await readdir(root)).sort()) {
        if (name === ".git" || name === ".pinata") continue;
        await visit(join(root, name));
      }
    } else await visit(sourcePath);
    const entryPath = relative(root, sourcePath).split("\\").join("/");
    const entry = files.find((file) => file.path === entryPath);
    if (
      !entry ||
      digestBytes(initial.bytes) !== entry.artifact.digest ||
      digestBytes((await resource(sourcePath)).bytes) !== entry.artifact.digest
    )
      throw new DomainError("conflict", `Selected skill changed while freezing: ${sourcePath}`);
    frozen.push(
      frozenSkillSchema.parse({
        name: skill.name,
        description: skill.description,
        sourcePath,
        entryPath,
        files,
        digest: digestValue(files),
      }),
    );
  }
  return frozen;
}

async function directory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isExisting(error)) throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new DomainError(
      "conflict",
      `Frozen resource directory is a link or non-directory: ${path}`,
    );
}

export async function readLoadout(
  ref: ArtifactRef,
  artifacts: ArtifactPort,
): Promise<FrozenLoadout> {
  const bytes = Buffer.from(await artifacts.read(ref));
  if (digestBytes(bytes) !== ref.digest || bytes.length !== ref.size)
    throw new DomainError(
      "context_unavailable",
      "Frozen loadout content does not match its retained reference",
    );
  return loadoutSchema.parse(JSON.parse(bytes.toString("utf8")));
}

export async function materializeSkills(
  skills: readonly FrozenSkill[],
  artifacts: ArtifactPort,
  root: string,
): Promise<string[]> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await directory(root);
  const paths: string[] = [];
  for (const skill of skills) {
    if (digestValue(skill.files) !== skill.digest)
      throw new DomainError("conflict", "Frozen skill resource manifest changed");
    const target = join(root, skill.digest);
    await directory(target);
    for (const file of skill.files) {
      if (validateManifestPath(file.path))
        throw new DomainError("invalid_input", "Frozen skill contains an unsafe resource path");
      const parts = file.path.split("/");
      let parent = target;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        await directory(parent);
      }
      const path = join(parent, parts.at(-1) ?? "");
      const bytes = Buffer.from(await artifacts.read(file.artifact));
      if (digestBytes(bytes) !== file.artifact.digest || bytes.length !== file.artifact.size)
        throw new DomainError("context_unavailable", `Frozen skill artifact changed: ${file.path}`);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
          throw new DomainError("conflict", "Frozen skill file became a link or non-file");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await publishImmutable(path, bytes, "skill-resource");
      await chmod(path, file.executable ? 0o700 : 0o600);
    }
    await syncDirectory(target);
    if (!skill.files.some((file) => file.path === skill.entryPath))
      throw new DomainError("conflict", "Frozen skill lacks its entry file");
    paths.push(join(target, skill.entryPath));
  }
  return paths;
}

export async function verifyProviders(loadout: FrozenLoadout): Promise<string[]> {
  for (const provider of loadout.providers) {
    const bytes = await readFile(provider.path);
    if (digestBytes(bytes) !== provider.artifact.digest || bytes.length !== provider.artifact.size)
      throw new DomainError(
        "context_unavailable",
        `Frozen tool provider changed: ${provider.path}`,
      );
  }
  return loadout.providers.map((provider) => provider.path);
}
