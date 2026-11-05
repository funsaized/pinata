// Samples only the known agent PIDs. RSS includes shared pages and excludes descendants;
// each observed maximum is a lower bound, not an OS high-water mark.
import { processRss } from "../engine/core/telemetry.ts";
import { rssMethod } from "./rss-reader.ts";

export interface ChildMemory {
  peakRssByAgentMB: Record<string, number>;
  rssSamplesByAgent: Record<string, number>;
  readyRssSamplesByAgent: Record<string, number>;
  sampleIntervalMs: number;
  rssMethod?: string;
  errors: string[];
}

export class ChildMemorySampler {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  private resample = false;
  private readonly peaks = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  private readonly readyCounts = new Map<string, number>();
  private readonly errors = new Set<string>();
  private readonly discover: () => Promise<Map<number, string>>;
  private readonly read: typeof processRss;
  private readonly ready: () => ReadonlySet<string>;
  readonly intervalMs: number;
  private readonly method: string;

  constructor(
    discover: () => Promise<Map<number, string>>,
    options: {
      intervalMs?: number;
      read?: typeof processRss;
      ready: () => ReadonlySet<string>;
      rssMethod?: string;
    },
  ) {
    this.discover = discover;
    this.read = options.read ?? processRss;
    this.ready = options.ready;
    this.intervalMs = options.intervalMs ?? 200;
    this.method = options.rssMethod ?? rssMethod();
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
  }

  sample(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) {
      this.resample = true;
      return this.pending;
    }
    this.pending = (async () => {
      do {
        this.resample = false;
        await this.take();
      } while (this.resample);
    })().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async take(): Promise<void> {
    try {
      const pids = await this.discover();
      const ready = new Set(this.ready());
      const rss = await this.read([...pids.keys()]);
      for (const [pid, value] of rss) {
        const agent = pids.get(pid);
        if (agent === undefined || value === null || !Number.isFinite(value) || value <= 0)
          continue;
        this.peaks.set(agent, Math.max(this.peaks.get(agent) ?? 0, value));
        this.counts.set(agent, (this.counts.get(agent) ?? 0) + 1);
        if (ready.has(agent)) this.readyCounts.set(agent, (this.readyCounts.get(agent) ?? 0) + 1);
      }
    } catch (error) {
      // Sampling is evidence: a read failure must be visible, never an unhandled rejection.
      if (this.errors.size < 10) this.errors.add(String(error));
    }
  }

  async stop(): Promise<ChildMemory> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
    return {
      peakRssByAgentMB: Object.fromEntries(this.peaks),
      rssSamplesByAgent: Object.fromEntries(this.counts),
      readyRssSamplesByAgent: Object.fromEntries(this.readyCounts),
      sampleIntervalMs: this.intervalMs,
      rssMethod: this.method,
      errors: [...this.errors],
    };
  }
}
