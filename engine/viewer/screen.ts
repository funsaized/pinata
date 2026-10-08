// The external viewer's screen: a run picker, an agent picker and the agent detail view
// (the same component as in Pi), fed by a socket connection to the run. It follows newly
// started agents until the user picks one, and keeps the last state when the run goes away.
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentEvent } from "../core/types.ts";
import type { RunView } from "../core/view.ts";
import type { IpcClient } from "../ipc/client.ts";
import { AgentDetail, type DetailSource } from "../ui/detail.ts";
import type { Keys } from "../ui/live.ts";
import { GLYPHS, progressLine, short } from "../ui/text.ts";
import type { Paint } from "../ui/widget.ts";

export interface ViewerOptions {
  tui: { requestRender(): void; terminal?: { rows: number } };
  theme: Paint;
  keys: Keys;
  done: () => void;
  // Live runs to pick from (run directories), and how to connect to one.
  runs: string[];
  connect(dir: string): Promise<IpcClient>;
  cwd: string;
  task?: string;
}

const HEADER_ROWS = 2;

export class ViewerScreen {
  readonly options: ViewerOptions;
  client: IpcClient | null = null;
  detail: AgentDetail | null = null;
  index = 0;
  following = true;
  status = "connecting…";
  disposed = false;
  private stop: (() => void) | null = null;
  private generation = 0;
  ready: Promise<void>;

  constructor(options: ViewerOptions) {
    this.options = options;
    this.following = !options.task;
    this.ready = this.attach(0);
  }

  get view(): RunView | null {
    return this.client?.view ?? null;
  }

  // Connects to the run at `index` of the picker (re-attaching drops the old connection).
  async attach(index: number): Promise<void> {
    const generation = ++this.generation;
    this.detach();
    this.index = index;
    this.status = "connecting…";
    this.options.tui.requestRender();
    let client: IpcClient;
    try {
      client = await this.options.connect(this.options.runs[index]);
    } catch (error) {
      if (generation === this.generation) {
        this.status = (error as Error).message;
        this.options.tui.requestRender();
      }
      return;
    }
    if (this.disposed || generation !== this.generation) return client.close();
    this.client = client;
    this.status = "live";
    const view = client.view!;
    const first =
      (this.options.task && view.agents[this.options.task] && this.options.task) ||
      view.order.find((id) => view.agents[id].status === "running") ||
      view.order[0];
    this.detail = new AgentDetail({
      tui: this.innerTui(),
      theme: this.options.theme,
      keys: this.options.keys,
      done: () => this.close(),
      source: this.source(client),
      agent: first,
    });
    this.detail.onSwitch = () => (this.following = false);
    this.stop = client.on((update) => {
      if (update.kind === "events") this.follow(update.events);
      if (update.kind === "closed") this.status = "disconnected (the run settled or Pi exited)";
      if (update.kind === "error") this.status = update.message;
      this.options.tui.requestRender();
    });
    await this.detail.ready;
  }

  // Follows the newest agent that starts, until the user picks one.
  private follow(events: AgentEvent[]): void {
    if (!this.following || !this.detail) return;
    const started = events.filter((e) => e.t === "agent_started").at(-1);
    if (started?.agent && started.agent !== this.detail.agent) this.detail.select(started.agent);
  }

  private innerTui() {
    const tui = this.options.tui;
    return {
      requestRender: () => tui.requestRender(),
      get terminal() {
        return { rows: Math.max(6, (tui.terminal?.rows ?? 32) - HEADER_ROWS) };
      },
    };
  }

  private source(client: IpcClient): DetailSource {
    const run = client.view!.run;
    return {
      run,
      cwd: this.options.cwd,
      agents: () => client.view?.order ?? [],
      view: (agent) => client.view?.agents[agent],
      load: (agent) => client.messages(agent),
      subscribe: (agent, onEvent) =>
        client.on((update) => {
          if (update.kind !== "events") return;
          for (const e of update.events) if (e.agent === agent) onEvent(e);
        }),
      steer: async (agent, text, as) => {
        if (client.closed) throw new Error("The viewer is disconnected");
        client.steer(agent, text, as);
      },
    };
  }

  handleInput(data: string): void {
    if (this.options.keys.matches(data, "tui.input.tab") && !this.detail?.input) {
      if (this.options.runs.length > 1)
        void this.attach((this.index + 1) % this.options.runs.length);
      return;
    }
    if (this.detail) this.detail.handleInput(data);
    else if (this.options.keys.matches(data, "tui.select.cancel")) this.close();
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const view = this.view;
    const runs =
      this.options.runs.length > 1
        ? ` (run ${this.index + 1}/${this.options.runs.length}, Tab)`
        : "";
    const head = view
      ? `pinata view · ${progressLine(view)}${runs}`
      : `pinata view · ${short(this.options.runs[this.index]?.split(/[\\/]/).at(-1) ?? "")}${runs}`;
    const agents = view
      ? view.order
          .map((id) => {
            const label = `${GLYPHS[view.agents[id].status]} ${id}`;
            return id === this.detail?.agent ? theme.fg("accent", `[${label}]`) : label;
          })
          .join("  ")
      : "";
    const state =
      this.status === "live"
        ? theme.fg("success", this.following ? "live · following" : "live")
        : theme.fg("warning", this.status);
    const lines = [
      truncateToWidth(`${theme.fg("accent", head)}  ${state}`, width),
      truncateToWidth(agents, width),
    ];
    return [...lines, ...(this.detail ? this.detail.render(width) : [])];
  }

  invalidate(): void {
    this.detail?.invalidate();
  }

  private detach(): void {
    this.stop?.();
    this.stop = null;
    this.detail?.dispose();
    this.detail = null;
    this.client?.close();
    this.client = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.detach();
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.options.done();
  }
}
