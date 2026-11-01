// Shared command grammar and run selection for the Pi command and the terminal viewer.
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { listRuns, replay, runsRoot } from "../core/store.ts";
import type { RunView } from "../core/view.ts";

import type { ViewArgs } from "./arguments.mjs";
export { commandWords, parseViewArgs, VIEW_ARGS } from "./arguments.mjs";
export type { ViewArgs } from "./arguments.mjs";

// Prefer this session's active work, then other active work, then recorded history.
export function orderRuns(views: RunView[], session = new Set<string>()): RunView[] {
  const priority = (v: RunView) => (v.status === "running" ? (session.has(v.run) ? 2 : 1) : 0);
  return [...views].sort(
    (a, b) => priority(b) - priority(a) || b.startedAt - a.startedAt || b.run.localeCompare(a.run),
  );
}

export function requireTask(view: RunView, task?: string): void {
  if (task && !view.agents[task])
    throw new Error(
      `Run ${view.run.slice(0, 8)} has no task ${task} (tasks: ${view.order.join(", ")})`,
    );
}

export interface RunRecord {
  dir: string;
  view: RunView;
}

// Only open viewers scan for new runs. Unchanged logs are never replayed again.
export class RunCatalog {
  private readonly cache = new Map<string, { stamp: string; view: RunView }>();

  async read(dir: string): Promise<RunRecord> {
    const st = await stat(join(dir, "events.jsonl"));
    const stamp = `${st.mtimeMs}:${st.size}`;
    let cached = this.cache.get(dir);
    if (cached?.stamp !== stamp) {
      const view = await replay(dir);
      if (!view.run) throw new Error(`No run events in ${dir}`);
      this.cache.set(dir, (cached = { stamp, view }));
    }
    return { dir, view: cached.view };
  }

  async list(root: string): Promise<RunRecord[]> {
    const dirs = await listRuns(root);
    const records = await Promise.all(dirs.map((dir) => this.read(dir).catch(() => null)));
    const byId = new Map(records.filter((r) => r !== null).map((r) => [r.view.run, r]));
    for (const dir of this.cache.keys()) if (!dirs.includes(dir)) this.cache.delete(dir);
    return orderRuns([...byId.values()].map((r) => r.view)).map((v) => byId.get(v.run)!);
  }
}

export interface ViewSpec {
  runs: string[];
  // Present only for an unqualified view: discover new repository runs while it is open.
  root?: string;
  task?: string;
  cwd: string;
}

export async function resolveView(args: ViewArgs, cwd: string): Promise<ViewSpec> {
  const catalog = new RunCatalog();
  if (args.run && (await stat(join(resolve(cwd, args.run), "events.jsonl")).catch(() => null))) {
    const record = await catalog.read(resolve(cwd, args.run));
    requireTask(record.view, args.task);
    return { runs: [record.dir], task: args.task, cwd };
  }
  const root = await runsRoot(cwd);
  const all = await catalog.list(root);
  if (args.run) {
    const matches = all.filter((r) => r.view.run.startsWith(args.run!));
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `Run prefix ${args.run} is ambiguous`
          : `Unknown run ${args.run}. Use --task <task> to select a conversation.`,
      );
    requireTask(matches[0].view, args.task);
    return { runs: [matches[0].dir], task: args.task, cwd };
  }
  if (args.task) {
    if (!all.length) throw new Error("No pinata runs in this repository.");
    requireTask(all[0].view, args.task);
    return { runs: [all[0].dir], task: args.task, cwd };
  }
  return { runs: all.map((r) => r.dir), root, cwd };
}
