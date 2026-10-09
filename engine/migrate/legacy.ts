// Retiring 0.7.0 run directories (E9.2), with 0.7.0's GC rules: a preview by default; never
// a locked, active or uncertain run, or one whose background coordinator still runs; a
// 0.7.0 pane is closed only while it is still the pane 0.7.0 recorded and its shell is
// idle; a worktree is removed only when it holds nothing that is not elsewhere (clean, or a
// builder's changes that integration verified and the checkout still holds byte for byte).
// Run artifacts (manifest, task evidence) are always kept; a retired run gets retired.json.
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  closeWorkspace,
  insideHerdr,
  owned,
  readyShell,
  type PaneResource,
} from "../herdr/client.ts";
import { git, line } from "../workspace/git.ts";

const TERMINAL = ["succeeded", "rejected", "failed", "blocked", "cancelled"];

export interface LegacyItem {
  run: string;
  what: string; // "run", a pane id or a worktree path
  action:
    | "retained"
    | "would close"
    | "closed"
    | "would remove"
    | "removed"
    | "retired"
    | "would retire";
  reason?: string;
}

interface Manifest {
  id: string;
  cwd: string;
  tasks: Array<{
    spec: { id: string; role: string };
    status: string;
    worktree?: string;
    worktreeRemoved?: boolean;
    attempts: Array<{ resource?: PaneResource; closed?: boolean }>;
  }>;
  background?: { runner?: { pid: number } | null };
  integration?: { status?: string } | null;
}

const isLegacy = (dir: string) =>
  existsSync(join(dir, "manifest.json")) && !existsSync(join(dir, "events.jsonl"));

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Whether a worktree holds anything not also in the checkout.
async function worktreeIsSpare(
  worktree: string,
  checkout: string,
  builder: boolean,
  integration: string | undefined,
): Promise<string | null> {
  const status = await git(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (!status) return null;
  if (!builder) return "the worktree has local changes";
  if (integration !== "verified") return "the builder's changes were never integrated (verified)";
  for (const entry of status.split("\0").filter(Boolean)) {
    const path = entry.slice(3);
    const [a, b] = await Promise.all([
      readFile(join(worktree, path)).catch(() => null),
      readFile(join(checkout, path)).catch(() => null),
    ]);
    if (!a || !b || !a.equals(b)) return `${path} differs from the checkout`;
  }
  return null;
}

export async function retireLegacy(
  runsRoot: string,
  options: { confirm?: boolean } = {},
): Promise<LegacyItem[]> {
  const items: LegacyItem[] = [];
  const names = existsSync(runsRoot) ? (await readdir(runsRoot)).sort() : [];
  for (const name of names) {
    const dir = join(runsRoot, name);
    if (!/^[a-f0-9-]{36}$/.test(name) || !isLegacy(dir)) continue;
    if (existsSync(join(dir, "retired.json"))) continue;
    const report: LegacyItem[] = [];
    const retain = (what: string, reason: string) =>
      report.push({ run: name, what, action: "retained", reason });
    try {
      if (!(await lstat(dir)).isDirectory()) throw new Error("not a real directory");
      if (existsSync(join(dir, "coordinator.lock")))
        throw new Error("the run is locked; unlock its stopped 0.7.0 coordinator first");
      const m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
      if (m.id !== name) throw new Error("the run id differs from its directory");
      if (!m.tasks.every((t) => TERMINAL.includes(t.status)))
        throw new Error("active or uncertain work cannot be retired");
      const runner = m.background?.runner?.pid;
      if (runner && running(runner)) throw new Error("its background coordinator is still running");
      let keep = false;
      for (const task of m.tasks)
        for (const attempt of task.attempts) {
          if (!attempt.resource || attempt.closed) continue;
          const pane = attempt.resource.pane_id;
          if (!insideHerdr()) {
            retain(pane, "a 0.7.0 pane may still be open; run inside Herdr to close it");
            keep = true;
            continue;
          }
          try {
            if (!(await owned(attempt.resource))) {
              attempt.closed = true; // gone, or another pane now: never touched
              continue;
            }
            await readyShell(attempt.resource, { timeoutMs: 1000 });
            if (options.confirm) {
              await closeWorkspace(attempt.resource);
              attempt.closed = true;
            }
            report.push({
              run: name,
              what: pane,
              action: options.confirm ? "closed" : "would close",
            });
          } catch (error) {
            retain(pane, `the pane is busy (${(error as Error).message})`);
            keep = true;
          }
        }
      const trees = new Map<string, Manifest["tasks"]>();
      for (const task of m.tasks)
        if (task.worktree && !task.worktreeRemoved)
          trees.set(task.worktree, [...(trees.get(task.worktree) ?? []), task]);
      for (const [worktree, tasks] of trees) {
        if (!existsSync(worktree)) continue;
        const why = await worktreeIsSpare(
          worktree,
          m.cwd,
          tasks.some((t) => t.spec.role === "builder"),
          m.integration?.status,
        ).catch((error: Error) => error.message);
        if (why) {
          retain(worktree, why);
          keep = true;
          continue;
        }
        if (options.confirm) {
          await git(m.cwd, ["worktree", "remove", "--force", worktree]);
          for (const t of tasks) t.worktreeRemoved = true;
        }
        report.push({
          run: name,
          what: worktree,
          action: options.confirm ? "removed" : "would remove",
        });
      }
      if (!keep) {
        if (options.confirm)
          await writeFile(
            join(dir, "retired.json"),
            JSON.stringify({ at: new Date().toISOString(), report }, null, 2) + "\n",
            { mode: 0o600 },
          );
        report.push({
          run: name,
          what: "run",
          action: options.confirm ? "retired" : "would retire",
        });
      }
      if (options.confirm)
        await writeFile(join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n", {
          mode: 0o600,
        });
    } catch (error) {
      retain("run", (error as Error).message);
    }
    items.push(...report);
  }
  return items;
}

// The repository's git common dir, where 0.7.0 kept its runs too.
export async function legacyRoot(cwd: string): Promise<string> {
  const common = line(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return join(common, "pinata");
}
