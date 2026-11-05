// Samples only the known agent PIDs. RSS includes shared pages and excludes descendants;
// each observed maximum is a lower bound, not an OS high-water mark.
import { processRss } from "../engine/core/telemetry.ts";

export interface ChildMemory {
  peakRssByAgentMB: Record<string, number>;
  rssSamplesByAgent: Record<string, number>;
  readyRssSamplesByAgent: Record<string, number>;
  loadedRssWaitByAgentMs: Record<string, number>;
  loadedRssWaitTimeoutMs: number;
  sampleIntervalMs: number;
  errors: string[];
}

export class ChildMemorySampler {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  private generation = 0;
  private completed = 0;
  private requested = 0;
  private readonly waiters: Array<{ generation: number; resolve: () => void }> = [];
  private readonly peaks = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  private readonly readyCounts = new Map<string, number>();
  private readonly errors = new Set<string>();
  private readonly loadedWaits = new Map<string, Promise<void>>();
  private readonly loadedWaitMs = new Map<string, number>();
  private readonly discover: () => Promise<Map<number, string>>;
  private readonly read: typeof processRss;
  private readonly ready: () => ReadonlySet<string>;
  readonly intervalMs: number;
  readonly loadedRssWaitTimeoutMs: number;

  constructor(
    discover: () => Promise<Map<number, string>>,
    options: {
      intervalMs?: number;
      read?: typeof processRss;
      ready: () => ReadonlySet<string>;
      loadedRssWaitTimeoutMs?: number;
    },
  ) {
    this.discover = discover;
    this.read = options.read ?? processRss;
    this.ready = options.ready;
    this.intervalMs = options.intervalMs ?? 200;
    this.loadedRssWaitTimeoutMs = options.loadedRssWaitTimeoutMs ?? 5000;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
  }

  sample(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // A caller arriving during an OS read needs the next generation: the current
    // read may have captured readiness before that caller's provider request.
    const generation = this.generation + 1;
    this.requested = generation;
    const done = new Promise<void>((resolve) => this.waiters.push({ generation, resolve }));
    if (!this.pending) this.drain();
    return done;
  }

  private drain(): void {
    this.pending = (async () => {
      while (this.completed < this.requested) {
        this.generation++;
        await this.take();
        this.completed = this.generation;
        while (this.waiters[0] && this.waiters[0].generation <= this.completed)
          this.waiters.shift()!.resolve();
      }
    })().finally(() => {
      this.pending = undefined;
      // A resolved caller may request a sample between the loop ending and this
      // finally callback. Its generation must still get an OS read.
      if (this.completed < this.requested) this.drain();
    });
  }

  /** Hold only the first provider response, never an unbounded periodic drain. */
  waitForReady(agent: string): Promise<void> {
    const existing = this.loadedWaits.get(agent);
    if (existing) return existing;
    const started = performance.now();
    const waiting = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.sample(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Loaded RSS wait timed out for ${agent} after ${this.loadedRssWaitTimeoutMs} ms`,
                  ),
                ),
              this.loadedRssWaitTimeoutMs,
            );
          }),
        ]);
        if (!this.readyCounts.get(agent))
          throw new Error(
            `Loaded RSS sample unavailable for ${agent} at its first provider request`,
          );
      } catch (error) {
        if (this.errors.size < 10) this.errors.add(String(error));
        throw error;
      } finally {
        clearTimeout(timer);
        this.loadedWaitMs.set(agent, performance.now() - started);
      }
    })();
    this.loadedWaits.set(agent, waiting);
    return waiting;
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
    while (this.pending) await this.pending;
    return {
      peakRssByAgentMB: Object.fromEntries(this.peaks),
      rssSamplesByAgent: Object.fromEntries(this.counts),
      readyRssSamplesByAgent: Object.fromEntries(this.readyCounts),
      loadedRssWaitByAgentMs: Object.fromEntries(this.loadedWaitMs),
      loadedRssWaitTimeoutMs: this.loadedRssWaitTimeoutMs,
      sampleIntervalMs: this.intervalMs,
      errors: [...this.errors],
    };
  }
}
