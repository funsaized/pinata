// The task graph: indegrees and a ready queue. Settling a task updates its dependents in the
// same call, so a dependent is ready as soon as its last predecessor settles.
import type { Task } from "./types.ts";

export class Graph {
  readonly tasks = new Map<string, Task>();
  private readonly waiting = new Map<string, number>();
  private readonly dependents = new Map<string, string[]>();
  private readonly settled = new Map<string, boolean>();
  private readonly ready: string[] = [];

  constructor(tasks: readonly Task[] = []) {
    this.add(tasks);
  }

  // Adds validated tasks. Dependencies may name earlier or new tasks.
  add(tasks: readonly Task[]): void {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
      this.dependents.set(task.id, this.dependents.get(task.id) ?? []);
    }
    for (const task of tasks) {
      let open = 0;
      for (const dep of task.after) {
        this.dependents.get(dep)!.push(task.id);
        if (!this.settled.has(dep)) open++;
      }
      this.waiting.set(task.id, open);
      if (open === 0 && !task.after.some((d) => this.settled.get(d) === false))
        this.ready.push(task.id);
    }
  }

  // Removes and returns the tasks whose dependencies all succeeded.
  takeReady(): string[] {
    return this.ready.splice(0);
  }

  isSettled(id: string): boolean {
    return this.settled.has(id);
  }

  get pending(): number {
    return this.tasks.size - this.settled.size;
  }

  // Records a settled task. Returns dependents that became ready and, when the task did not
  // succeed, every transitive dependent that is now blocked (they settle as blocked).
  settle(
    id: string,
    succeeded: boolean,
  ): { ready: string[]; blocked: Array<{ id: string; by: string }> } {
    if (this.settled.has(id)) return { ready: [], blocked: [] };
    this.settled.set(id, succeeded);
    const ready: string[] = [];
    const blocked: Array<{ id: string; by: string }> = [];
    if (succeeded) {
      for (const dep of this.dependents.get(id) ?? []) {
        if (this.settled.has(dep)) continue;
        const left = this.waiting.get(dep)! - 1;
        this.waiting.set(dep, left);
        if (left === 0 && this.tasks.get(dep)!.after.every((d) => this.settled.get(d) === true)) {
          ready.push(dep);
          this.ready.push(dep);
        }
      }
      return { ready, blocked };
    }
    const queue = [...(this.dependents.get(id) ?? [])].map((dep) => ({ id: dep, by: id }));
    while (queue.length) {
      const next = queue.shift()!;
      if (this.settled.has(next.id)) continue;
      this.settled.set(next.id, false);
      const at = this.ready.indexOf(next.id);
      if (at !== -1) this.ready.splice(at, 1);
      blocked.push(next);
      for (const dep of this.dependents.get(next.id) ?? []) queue.push({ id: dep, by: next.id });
    }
    return { ready, blocked };
  }

  // Reopens a settled task (a repair) and its settled dependents. Returns the reopened ids.
  reopen(id: string): string[] {
    const reopened: string[] = [];
    const visit = (name: string) => {
      if (!this.settled.has(name)) return;
      this.settled.delete(name);
      reopened.push(name);
      for (const dep of this.dependents.get(name) ?? []) visit(dep);
    };
    visit(id);
    for (const name of reopened) {
      const task = this.tasks.get(name)!;
      const open = task.after.filter((d) => !this.settled.has(d)).length;
      this.waiting.set(name, open);
      if (open === 0 && task.after.every((d) => this.settled.get(d) === true))
        this.ready.push(name);
    }
    return reopened;
  }
}
