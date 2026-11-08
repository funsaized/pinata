// Dependencies name accepted assignments, never a worker's mutable latest result.
import type { AssignmentRef } from "./types.ts";
export const assignmentKey = (ref: AssignmentRef): string => `${ref.worker}/${ref.assignment}`;
export type GraphNode = AssignmentRef & { after: AssignmentRef[] };
export class Graph {
  readonly nodes = new Map<string, GraphNode>();
  private readonly completed = new Set<string>();
  private readonly started = new Set<string>();
  constructor(nodes: readonly GraphNode[] = []) {
    this.add(nodes);
  }
  add(nodes: readonly GraphNode[]): void {
    const all = new Map(this.nodes);
    for (const node of nodes) {
      const key = assignmentKey(node);
      if (all.has(key)) throw new Error(`Duplicate assignment ${key}`);
      all.set(key, node);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): void => {
      if (visiting.has(key)) throw new Error(`Cyclic assignment dependency at ${key}`);
      if (visited.has(key)) return;
      const node = all.get(key);
      if (!node) throw new Error(`Unknown assignment ${key}`);
      visiting.add(key);
      for (const ref of node.after) visit(assignmentKey(ref));
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of all.keys()) visit(key);
    for (const node of nodes) this.nodes.set(assignmentKey(node), structuredClone(node));
  }
  takeReady(): string[] {
    const ready: string[] = [];
    for (const [key, node] of this.nodes) {
      if (this.started.has(key) || this.completed.has(key)) continue;
      if (!node.after.every((ref) => this.completed.has(assignmentKey(ref)))) continue;
      this.started.add(key);
      ready.push(key);
    }
    return ready;
  }
  settle(key: string): void {
    this.completed.add(key);
  }
  isSettled(key: string): boolean {
    return this.completed.has(key);
  }
  get pending(): number {
    return this.nodes.size - this.completed.size;
  }
}
