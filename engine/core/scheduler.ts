// Starts ready tasks through the limiter. Settling a task releases its slot, updates the graph
// and starts newly ready dependents in the same call stack.
import type { Graph } from "./graph.ts";
import type { Limiter } from "./limiter.ts";

export class Scheduler {
  private readonly graph: Graph;
  private readonly limiter: Limiter;
  private readonly provider: (id: string) => string;
  private readonly start: (id: string) => void;
  // Ready tasks waiting for a concurrency slot, in readiness order.
  private readonly waiting: string[] = [];
  private readonly holding = new Map<string, string>();
  private stopped = false;
  // The run's own cap (limits.concurrency), under the engine-wide limiter.
  private readonly maxRunning: number;

  constructor(
    graph: Graph,
    limiter: Limiter,
    provider: (id: string) => string,
    start: (id: string) => void,
    maxRunning = Infinity,
  ) {
    this.maxRunning = maxRunning;
    this.graph = graph;
    this.limiter = limiter;
    this.provider = provider;
    this.start = start;
  }

  get queued(): readonly string[] {
    return this.waiting;
  }

  get running(): number {
    return this.holding.size;
  }

  // Starts every ready task the limiter allows. Returns how many started.
  pump(): number {
    if (this.stopped) return 0;
    this.waiting.push(...this.graph.takeReady());
    let started = 0;
    for (let i = 0; i < this.waiting.length && this.holding.size < this.maxRunning;) {
      const id = this.waiting[i];
      const provider = this.provider(id);
      if (!this.limiter.tryAcquire(provider)) {
        i++;
        continue;
      }
      this.waiting.splice(i, 1);
      this.holding.set(id, provider);
      started++;
      this.start(id);
      if (this.stopped) break;
    }
    return started;
  }

  // Records a settled task and starts what became ready.
  settle(
    id: string,
    succeeded: boolean,
  ): { ready: string[]; blocked: Array<{ id: string; by: string }> } {
    this.release(id);
    const at = this.waiting.indexOf(id);
    if (at !== -1) this.waiting.splice(at, 1);
    const outcome = this.graph.settle(id, succeeded);
    for (const b of outcome.blocked) {
      const i = this.waiting.indexOf(b.id);
      if (i !== -1) this.waiting.splice(i, 1);
    }
    return outcome;
  }

  release(id: string): void {
    const provider = this.holding.get(id);
    if (provider === undefined) return;
    this.holding.delete(id);
    this.limiter.release(provider);
  }

  // Starts work again after a run reopened.
  resume(): void {
    this.stopped = false;
  }

  // Stops starting work. Returns tasks that never started.
  stop(): string[] {
    this.stopped = true;
    this.waiting.push(...this.graph.takeReady());
    return this.waiting.splice(0);
  }
}
