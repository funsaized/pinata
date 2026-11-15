import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DomainError, manifestSchema } from "../contracts/index.ts";
import { isMissing } from "../storage/io.ts";
import { discoverWorkspaceStore } from "../workspace/location.ts";
import { openSavedSource } from "./saved.ts";
import type { RuntimeSource } from "./runtime.ts";

export type ProjectRun = {
  run: string;
  directory: string;
  workspace: string;
  createdAt?: string;
  live: boolean;
  control: boolean;
};
export type ProjectRunList = { runs: ProjectRun[]; skipped: number };
export type ProjectRunCatalog = {
  workspace: string;
  list(): Promise<ProjectRunList>;
  open(run: ProjectRun): Promise<RuntimeSource>;
};

async function projectIdentity(workspace: string): Promise<string> {
  const location = await discoverWorkspaceStore(workspace);
  return location.commonDirectory ?? location.root;
}

// Discovery reads only this project's store and explicitly bound sources. It
// never opens an owning host, scans global sessions or grants control.
export function projectRuns(
  workspace: string,
  sources: () => readonly RuntimeSource[],
): ProjectRunCatalog {
  const opened = new Map<string, RuntimeSource>();
  const manifest = async (directory: string, identity: string): Promise<ProjectRun | undefined> => {
    const canonical = await realpath(directory);
    const saved = manifestSchema.parse(
      JSON.parse(await readFile(join(canonical, "run.json"), "utf8")),
    );
    if (
      (await realpath(saved.store)) !== canonical ||
      (await projectIdentity(saved.workspace)) !== identity
    )
      return undefined;
    return {
      run: saved.run,
      workspace: saved.workspace,
      directory: canonical,
      createdAt: saved.createdAt,
      live: false,
      control: false,
    };
  };
  return {
    workspace,
    async list() {
      const location = await discoverWorkspaceStore(workspace);
      const identity = location.commonDirectory ?? location.root;
      const runs = new Map<string, ProjectRun>();
      let skipped = 0;
      let directories: string[] = [];
      try {
        directories = (await readdir(location.store, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(location.store, entry.name));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      for (let offset = 0; offset < directories.length; offset += 8) {
        const entries = await Promise.allSettled(
          directories.slice(offset, offset + 8).map((directory) => manifest(directory, identity)),
        );
        for (const entry of entries) {
          if (entry.status === "rejected") skipped++;
          else if (entry.value) runs.set(entry.value.directory, entry.value);
        }
      }
      for (const source of sources()) {
        if (!source.location) continue;
        try {
          if ((await projectIdentity(source.location.workspace)) !== identity) continue;
          const directory = await realpath(source.location.directory);
          runs.set(directory, {
            ...runs.get(directory),
            run: source.run,
            workspace: source.location.workspace,
            directory,
            live: source.capabilities.live,
            control: source.capabilities.control,
          });
        } catch {
          skipped++;
        }
      }
      return {
        runs: [...runs.values()].sort(
          (left, right) =>
            Number(right.live) - Number(left.live) ||
            (right.createdAt ?? "").localeCompare(left.createdAt ?? "") ||
            left.run.localeCompare(right.run),
        ),
        skipped,
      };
    },
    async open(run) {
      const identity = await projectIdentity(workspace);
      const directory = await realpath(run.directory);
      for (const source of sources()) {
        if (
          source.location &&
          source.run === run.run &&
          (await realpath(source.location.directory)) === directory &&
          (await projectIdentity(source.location.workspace)) === identity
        )
          return source;
      }
      const checked = await manifest(directory, identity);
      if (!checked || checked.run !== run.run)
        throw new DomainError("conflict", "This run no longer belongs to the selected project");
      const existing = opened.get(directory);
      if (existing) return existing;
      const source = await openSavedSource(directory);
      opened.set(directory, source);
      return source;
    },
  };
}
