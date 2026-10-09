// The herdr-pi backend: each agent is an interactive Pi in its own Herdr workspace, which
// the user can watch and type into. The agent extension's reporter writes the session's
// events to the agent's events file, so the engine follows it exactly like a detached
// process agent (and the next Pi reattaches it the same way). Panes are opened without
// focus, checked for ownership before any control, and closed when the agent settles.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEventInput } from "../core/types.ts";
import {
  closeWorkspace,
  commandLine,
  createWorkspace,
  insideHerdr,
  readyShell,
  runInPane,
  type HerdrOptions,
  type PaneResource,
} from "../herdr/client.ts";
import { piCommand } from "./pi-command.ts";
import { agentFiles, followDetached, piArgs, type AgentFiles } from "./process.ts";
import type { ProcessIdentity } from "./supervise.ts";
import type { AgentBackend, AgentHandle, AgentLaunch } from "./types.ts";

// How long Pi in a new pane has to load the agent extension (which writes pid.json).
export const PANE_START_MS = 30_000;

export interface HerdrPiOptions {
  command?: string[];
  // Extra environment for the pane (tests pass PI_CODING_AGENT_DIR).
  env?: Record<string, string>;
  herdr?: HerdrOptions;
  webExtension?: string | null;
}

export const paneLabel = (launch: Pick<AgentLaunch, "run" | "task">) =>
  `pinata-${launch.run.slice(0, 8)}-${launch.task.id}`;

async function waitForIdentity(files: AgentFiles, ms = PANE_START_MS): Promise<ProcessIdentity> {
  const end = Date.now() + ms;
  for (;;) {
    const identity = await readFile(files.pid, "utf8")
      .then((raw) => JSON.parse(raw) as ProcessIdentity)
      .catch(() => null);
    if (identity?.pid) return identity;
    if (Date.now() > end) {
      const stderr = await readFile(files.stderr, "utf8").catch(() => "");
      throw new Error(
        `Pi did not start in the Herdr pane${stderr ? `: ${stderr.slice(-500)}` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Closes the agent's workspace after the handle is disposed (not on detach: it survives Pi).
function closingPane(handle: AgentHandle, pane: PaneResource, herdr?: HerdrOptions): AgentHandle {
  return {
    ...handle,
    done: handle.done,
    async dispose() {
      await handle.dispose();
      await closeWorkspace(pane, herdr).catch(() => {});
    },
  };
}

export class HerdrPiBackend implements AgentBackend {
  readonly kind = "herdr-pi" as const;
  private readonly options: HerdrPiOptions;

  constructor(options: HerdrPiOptions = {}) {
    this.options = options;
  }

  async start(
    launch: AgentLaunch,
    sink: (e: AgentEventInput) => void,
    signal: AbortSignal,
  ): Promise<AgentHandle> {
    if (!insideHerdr() && !this.options.herdr?.session)
      throw new Error("herdr-pi agents need Pi running inside Herdr");
    const files = await agentFiles(launch);
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    const web = launch.webExtension ?? this.options.webExtension ?? undefined;
    await writeFile(files.persona, launch.persona, { mode: 0o600 });
    await writeFile(files.brief, launch.brief, { mode: 0o600 });
    await writeFile(files.control, "", { mode: 0o600 });
    await writeFile(
      files.options,
      JSON.stringify({
        ...launch.agent,
        codemode: launch.codemode,
        detached: { control: files.control, remind: true, budgets: launch.budgets },
        reporter: { events: files.events, pid: files.pid, brief: files.brief },
      }),
      { mode: 0o600 },
    );
    const sessionDir =
      launch.mode === "observe" && files.runDir
        ? join(files.runDir, "sessions", launch.task.id)
        : undefined;
    const pane = await createWorkspace({
      ...this.options.herdr,
      cwd: launch.cwd,
      label: paneLabel(launch),
      env: {
        PINATA_AGENT: "1",
        PINATA_AGENT_OPTIONS_FILE: files.options,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        ...this.options.env,
      },
    });
    await writeFile(join(files.dir, "pane.json"), JSON.stringify(pane), { mode: 0o600 });
    let identity: ProcessIdentity;
    try {
      const shell = await readyShell(pane, this.options.herdr);
      const command = this.options.command ?? piCommand();
      const argv = [
        ...command,
        ...piArgs({ ...launch, ...(web && { webExtension: web }) }, files, sessionDir, "tui"),
      ];
      await runInPane(pane, commandLine(argv, shell.kind), this.options.herdr);
      identity = await waitForIdentity(files);
    } catch (error) {
      await closeWorkspace(pane, this.options.herdr).catch(() => {});
      throw error;
    }
    return closingPane(
      followDetached(files, identity, launch, sink, signal, undefined, 0),
      pane,
      this.options.herdr,
    );
  }

  async reattach(
    launch: AgentLaunch,
    sink: (e: AgentEventInput) => void,
    signal: AbortSignal,
  ): Promise<AgentHandle | null> {
    const files = await agentFiles(launch);
    const read = async <T>(file: string) =>
      readFile(file, "utf8")
        .then((raw) => JSON.parse(raw) as T)
        .catch(() => null);
    const identity = await read<ProcessIdentity>(files.pid);
    const pane = await read<PaneResource>(join(files.dir, "pane.json"));
    if (!identity || !pane) return null;
    const consumed = (await read<{ records: number }>(files.consumed))?.records ?? 0;
    return closingPane(
      followDetached(files, identity, launch, sink, signal, undefined, consumed),
      pane,
      this.options.herdr,
    );
  }
}
