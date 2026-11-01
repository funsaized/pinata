// External data adapter for the shared run workspace. The UI and input handling live in
// ui/workspace.ts; this controller owns socket/log connections and repository discovery.
import { RunWorkspace, type WorkspaceOptions, type WorkspaceRun } from "../ui/workspace.ts";
import { integrationStatus } from "../ui/integration.ts";
import { RunCatalog, requireTask, type RunRecord } from "./selection.ts";

import { clientDetail, reconnectViewer, type ViewerClient } from "./client.ts";
export type { ViewerClient } from "./client.ts";

export interface ViewerOptions extends Pick<
  WorkspaceOptions,
  "tui" | "theme" | "keys" | "done" | "motion"
> {
  runs: string[];
  root?: string;
  connect(dir: string): Promise<ViewerClient>;
  cwd: string;
  task?: string;
  pollMs?: number;
}

export class ViewerScreen {
  readonly options: ViewerOptions;
  readonly workspace: RunWorkspace;
  client: ViewerClient | null = null;
  status = "connecting…";
  disposed = false;
  ready: Promise<void>;
  private readonly catalog = new RunCatalog();
  private readonly records = new Map<string, RunRecord>();
  private readonly initialClients = new Map<string, ViewerClient>();
  private stop: (() => void) | null = null;
  private generation = 0;
  private pending: { run: string; promise: Promise<ViewerClient> } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private integration: string | null = null;

  constructor(options: ViewerOptions) {
    this.options = options;
    this.workspace = new RunWorkspace({
      ...options,
      runs: [],
      agent: options.task,
      followNewRuns: !!options.root && !options.task,
      done: () => {
        this.dispose();
        options.done();
      },
      readRun: (id) => this.read(id),
      detailSource: async (id) => {
        const client = await this.connect(id);
        this.workspace.offer({ view: client.view!, integration: this.integration });
        return clientDetail(client, this.records.get(id)!.dir, this.options.cwd);
      },
    });
    this.ready = this.initialize();
  }

  get detail() {
    return this.workspace.detail;
  }
  get view() {
    return this.workspace.run?.view ?? null;
  }

  private setStatus(status: string): void {
    this.status = status;
    this.workspace.connection = status;
    this.options.tui.requestRender();
  }

  private async initialize(): Promise<void> {
    try {
      const records = this.options.root
        ? await this.catalog.list(this.options.root)
        : await Promise.all(
            this.options.runs.map(async (dir) => {
              try {
                return await this.catalog.read(dir);
              } catch {
                // A socket can be ready before the first buffered run events reach disk.
                const client = await this.options.connect(dir);
                if (!client.view) {
                  client.close();
                  throw new Error(`No run state in ${dir}`);
                }
                if (this.disposed) client.close();
                else this.initialClients.set(client.view.run, client);
                return { dir, view: client.view };
              }
            }),
          );
      if (this.disposed) return;
      if (this.options.task) {
        if (!records.length) throw new Error("No pinata runs in this repository.");
        requireTask(records[0].view, this.options.task);
      }
      for (const record of records) this.records.set(record.view.run, record);
      this.workspace.runs.push(...records.map((r) => r.view.run));
      this.workspace.agent = this.options.task ?? null;
      this.workspace.focus = this.options.task ? "detail" : "agents";
      if (records.length) await this.workspace.refresh();
      else this.setStatus("Waiting for a run");
    } catch (error) {
      if (!this.disposed) {
        this.workspace.error = (error as Error).message;
        this.options.tui.requestRender();
      }
    }
    this.schedule();
  }

  private async read(id: string): Promise<WorkspaceRun> {
    const client = await this.connect(id);
    return { view: client.view!, integration: this.integration };
  }

  private connect(id: string): Promise<ViewerClient> {
    if (this.pending?.run === id) return this.pending.promise;
    if (this.client?.view?.run === id) return Promise.resolve(this.client);
    this.detach();
    const generation = this.generation;
    this.setStatus("connecting…");
    const promise = (async () => {
      const record = this.records.get(id);
      if (!record) throw new Error(`Unknown run ${id}`);
      const client = this.initialClients.get(id) ?? (await this.options.connect(record.dir));
      this.initialClients.delete(id);
      if (this.disposed || generation !== this.generation) {
        client.close();
        throw new Error("Run selection changed");
      }
      if (client.view?.run !== id) {
        client.close();
        throw new Error("Viewer source belongs to another run");
      }
      this.client = client;
      const integration = await integrationStatus(record.dir);
      if (this.disposed || generation !== this.generation) throw new Error("Run selection changed");
      this.integration = integration;
      this.setStatus(client.source === "socket" ? "live" : "from the run's log · read-only");
      this.stop = client.on((update) => {
        if (this.disposed || generation !== this.generation) return;
        if (update.kind === "events" || update.kind === "snapshot")
          this.workspace.offer({ view: client.view!, integration: this.integration });
        if (update.kind === "closed")
          this.setStatus(
            client.source === "socket"
              ? "disconnected · recorded output"
              : "from the run's log · read-only",
          );
        if (update.kind === "error") this.setStatus(update.message);
      });
      return client;
    })();
    this.pending = { run: id, promise };
    void promise
      .finally(() => {
        if (this.pending?.promise === promise) this.pending = null;
      })
      .catch(() => {});
    return promise;
  }

  private schedule(): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.discover().finally(() => this.schedule());
    }, this.options.pollMs ?? 1000);
    this.timer.unref?.();
  }

  // Reads only changed metadata; conversation streaming uses the selected client's events.
  async discover(): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.options.root) {
        const records = await this.catalog.list(this.options.root);
        if (this.disposed) return;
        for (const record of [...records].reverse()) {
          const fresh = !this.records.has(record.view.run);
          this.records.set(record.view.run, record);
          if (fresh) this.workspace.offer({ view: record.view, integration: null });
        }
      }
      const id = this.workspace.selected();
      const record = id && this.records.get(id);
      if (!record || this.disposed) return;
      const integration = await integrationStatus(record.dir);
      if (this.disposed || id !== this.workspace.selected()) return;
      if (integration !== this.integration && this.client?.view?.run === id) {
        this.integration = integration;
        this.workspace.offer({ view: this.client.view, integration });
      }
      // An already-open log viewer can gain streaming/steering after view --external.
      if (this.client && !this.detail?.input && (await reconnectViewer(this.client, record.dir))) {
        if (this.disposed || id !== this.workspace.selected()) return;
        this.detach();
        await this.workspace.reloadSource();
      }
    } catch (error) {
      if (!this.disposed) this.setStatus((error as Error).message);
    }
  }

  handleInput(data: string): void {
    this.workspace.handleInput(data);
  }
  handleMouse(event: Parameters<RunWorkspace["handleMouse"]>[0]) {
    return this.workspace.handleMouse(event);
  }
  render(width: number): string[] {
    return this.workspace.render(width);
  }
  invalidate(): void {
    this.workspace.invalidate();
  }

  private detach(): void {
    this.generation++;
    this.stop?.();
    this.stop = null;
    this.client?.close();
    this.client = null;
    this.pending = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.workspace.dispose();
    this.detach();
    for (const client of this.initialClients.values()) client.close();
    this.initialClients.clear();
  }

  close(): void {
    this.workspace.close();
  }
}
