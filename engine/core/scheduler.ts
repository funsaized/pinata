import type { Graph } from "./graph.ts";
// Parallelism belongs to the coordinator. Only graph order controls readiness.
export class Scheduler {
  private stopped = false;
  private readonly graph: Graph;
  private readonly start: (key: string) => void;
  constructor(graph: Graph, start: (key: string) => void) {
    this.graph = graph;
    this.start = start;
  }
  pump(): number {
    if (this.stopped) return 0;
    const ready = this.graph.takeReady();
    for (const key of ready) this.start(key);
    return ready.length;
  }
  settle(key: string): void {
    this.graph.settle(key);
  }
  stop(): void {
    this.stopped = true;
  }
  resume(): void {
    this.stopped = false;
  }
}
