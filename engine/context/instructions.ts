import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { type ArtifactPort } from "../contracts/backend.ts";
import { DomainError, type ArtifactRef } from "../contracts/common.ts";
import { canonicalJson } from "../contracts/digest.ts";
import { instructionSnapshotSchema, type InstructionSnapshot } from "../contracts/context.ts";
import { digestBytes, isMissing } from "../storage/io.ts";

const filenames = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function candidates(cwd: string, agentDir: string): string[] {
  const directories = new Set([resolve(agentDir)]);
  let directory = resolve(cwd);
  while (true) {
    directories.add(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...directories].flatMap((path) => filenames.map((name) => join(path, name)));
}

async function discover(paths: readonly string[]): Promise<InstructionSnapshot["candidates"]> {
  return Promise.all(
    paths.map(async (path) => {
      try {
        if (!(await stat(path)).isFile()) return { path, state: "other" as const };
        return { path, state: "file" as const, digest: digestBytes(await readFile(path)) };
      } catch (error) {
        if (isMissing(error)) return { path, state: "missing" as const };
        throw error;
      }
    }),
  );
}

// Discovery includes absent candidates and is repeated for every assignment. Pi's
// public loader remains the authority for precedence and linked-worktree shadowing.
export async function freezeInstructions(options: {
  cwd: string;
  agentDir: string;
  artifacts: Pick<ArtifactPort, "put">;
}): Promise<{
  artifact: ArtifactRef;
  snapshot: InstructionSnapshot;
  files: Array<{ path: string; content: string }>;
}> {
  const cwd = resolve(options.cwd);
  const paths = candidates(cwd, options.agentDir);
  const before = await discover(paths);
  const files = loadProjectContextFiles({ cwd, agentDir: options.agentDir });
  const frozen: InstructionSnapshot["files"] = [];
  for (const file of files) {
    const bytes = await readFile(file.path);
    const digest = digestBytes(bytes);
    if (
      before.find((candidate) => candidate.path === file.path)?.digest !== digest ||
      bytes.toString("utf8").replace(/^\uFEFF/, "") !== file.content
    )
      throw new DomainError("conflict", "Project instructions changed during discovery");
    frozen.push({ path: file.path, artifact: await options.artifacts.put(bytes) });
  }
  if (
    canonicalJson(before) !== canonicalJson(await discover(paths)) ||
    canonicalJson(files) !==
      canonicalJson(loadProjectContextFiles({ cwd, agentDir: options.agentDir }))
  )
    throw new DomainError("conflict", "Project instruction discovery changed during capture");
  const snapshot = instructionSnapshotSchema.parse({
    schemaVersion: 1,
    cwd,
    candidates: before,
    files: frozen,
  });
  const artifact = await options.artifacts.put(Buffer.from(canonicalJson(snapshot)));
  return { artifact, snapshot, files };
}
