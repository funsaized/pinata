import { assignmentKey, DomainError, type Assignment, type CoreState } from "../contracts/index.ts";

// Previously accepted edges are immutable, so only the new subgraph can create a cycle.
export function validateAssignmentGraph(state: CoreState, assignments: Assignment[]): void {
  const additions = new Map(
    assignments.map((assignment) => [assignmentKey(assignment.ref), assignment]),
  );
  const visited = new Set<string>();
  const visiting = new Set<string>();
  for (const initial of additions.keys()) {
    const pending: Array<{ key: string; exiting: boolean }> = [{ key: initial, exiting: false }];
    while (pending.length) {
      const current = pending.pop();
      if (!current) break;
      if (current.exiting) {
        visiting.delete(current.key);
        visited.add(current.key);
        continue;
      }
      if (visiting.has(current.key))
        throw new DomainError("invalid_input", "Assignment dependencies form a cycle", "after");
      if (visited.has(current.key) || Object.hasOwn(state.assignments, current.key)) continue;
      const assignment = additions.get(current.key);
      if (!assignment)
        throw new DomainError("dependency_missing", `Unknown assignment ${current.key}`, "after");
      visiting.add(current.key);
      pending.push({ key: current.key, exiting: true });
      for (const reference of assignment.after)
        pending.push({ key: assignmentKey(reference), exiting: false });
    }
  }
}
