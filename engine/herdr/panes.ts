// Pinata's Herdr panes beyond agents: viewer panes (E7.1) and GC of stale pinata
// workspaces (E7.5). Workspaces are labelled `pinata-<run prefix>-<task|view>`; nothing else
// is ever closed.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piCommand } from "../backends/pi-command.ts";
import { replay } from "../core/store.ts";
import {
  closeWorkspace,
  commandLine,
  createWorkspace,
  herdr,
  pinataWorkspaces,
  readyShell,
  runInPane,
  type HerdrOptions,
  type PaneResource,
} from "./client.ts";

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), "..", "viewer", "main.ts");

// Opens the viewer (E5.5) for a run in a new Herdr workspace, without focus.
export async function openViewerPane(
  options: {
    run: string;
    dir: string;
    cwd: string;
    task?: string;
    env?: Record<string, string>;
  } & HerdrOptions,
): Promise<PaneResource> {
  const pane = await createWorkspace({
    ...options,
    cwd: options.cwd,
    label: `pinata-${options.run.slice(0, 8)}-view`,
    env: {
      PINATA_VIEW: JSON.stringify({ runs: [options.dir], task: options.task, cwd: options.cwd }),
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      ...options.env,
    },
  });
  try {
    const shell = await readyShell(pane, options);
    const argv = [
      ...piCommand(),
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--extension",
      VIEWER,
    ];
    await runInPane(pane, commandLine(argv, shell.kind), options);
    return pane;
  } catch (error) {
    await closeWorkspace(pane, options).catch(() => {});
    throw error;
  }
}

export interface GcEntry {
  label: string;
  workspace_id: string;
  action: "closed" | "kept";
  reason: string;
}

// Closes pinata workspaces whose run or agent has settled (or whose run is gone) in the
// repository whose runs live in `runsRoot`. Everything kept gets a reason; workspaces
// without a pinata label are never listed.
export async function gcPanes(runsRoot: string, options: HerdrOptions = {}): Promise<GcEntry[]> {
  const entries: GcEntry[] = [];
  const runs = existsSync(runsRoot)
    ? (await import("node:fs/promises").then((fs) => fs.readdir(runsRoot))).filter((n) =>
        /^[a-f0-9-]{36}$/.test(n),
      )
    : [];
  for (const ws of await pinataWorkspaces(options)) {
    const [, prefix, name] = /^pinata-([0-9a-f]{8})-(.+)$/.exec(ws.label)!;
    const matches = runs.filter((r) => r.startsWith(prefix));
    const keep = (reason: string) => entries.push({ ...ws, action: "kept", reason });
    if (matches.length > 1) {
      keep(`run prefix ${prefix} is ambiguous in this repository`);
      continue;
    }
    if (!matches.length) {
      keep(`no run ${prefix} in this repository (another repository's, or a 0.7.0 pane)`);
      continue;
    }
    const dir = join(runsRoot, matches[0]);
    const view = await replay(dir).catch(() => null);
    const agent = name === "view" ? undefined : view?.agents[name];
    let close: string | null = null;
    if (!view) close = "its run has no log";
    else if (view.status !== "running") close = `its run ${view.status}`;
    else if (name !== "view" && !agent) {
      // The log may not list it yet (lean logs flush every 250 ms): never guess.
      keep(`its running run does not list task ${name} (yet)`);
      continue;
    } else if (agent && agent.status !== "running" && agent.status !== "queued")
      close = `its agent ${agent.status}`;
    if (!close) {
      keep(name === "view" ? "its run is still running" : "its agent is still running");
      continue;
    }
    // Close only a pane that is still the one pinata recorded for that agent.
    const recorded = name === "view" ? null : join(dir, "agents", name, "pane.json");
    const pane: PaneResource | null = recorded
      ? await readFile(recorded, "utf8")
          .then((raw) => JSON.parse(raw) as PaneResource)
          .catch(() => null)
      : null;
    if (pane && pane.workspace_id !== ws.workspace_id) {
      keep("it is not the workspace pinata recorded for that agent");
      continue;
    }
    if (pane) await closeWorkspace(pane, options);
    else await herdr(["workspace", "close", ws.workspace_id], options).catch(() => {});
    entries.push({ ...ws, action: "closed", reason: close });
  }
  return entries;
}
