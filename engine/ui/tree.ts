import {
  assignmentKey,
  type Assignment,
  type AssignmentRef,
  type CoreState,
} from "../contracts/index.ts";
import { assignments, isFinished, needsAttention } from "./projection.ts";

export function activityIndicator(
  motion: "full" | "reduced" | "off",
  now: number,
  prefix = "",
  row = 0,
  cycle = row + Math.min(prefix.length, 3) + 5,
  ascii = true,
): string {
  const rail = ascii ? "-" : "─";
  const branch = prefix.replace(/[-─] $/, rail + rail) + rail.repeat(5);
  if (motion !== "full") return branch;
  const frame = Math.floor(now / 250);
  const position = (frame % cycle) - row;
  return Array.from(branch, (character, column) => {
    if (character === " ") return character;
    // Indentation does not add empty travel frames before a connected branch.
    const distance = Math.max(0, column - Math.max(0, prefix.length - 3));
    if (position === distance) return ["c", "C", "c"][frame % 3];
    if (position < distance) return column % 2 === 0 ? "o" : " ";
    if (character === "─" || character === "-") return column % 2 === 0 ? "-" : " ";
    if (character === "│" || character === "├") return "┆";
    if (character === "|") return ":";
    return character;
  }).join("");
}

export type TreeNode = {
  assignment: Assignment;
  prefix: string;
  continuation: string;
  hasChildren: boolean;
};

// Nest only under the recorded parent assignment. Dependencies and repeated
// assignments are separate branches, never inferred parent/child relationships.
export function assignmentTree(
  state: CoreState,
  options: {
    ascii?: boolean;
    selected?: AssignmentRef;
    queued?: boolean;
    finished?: boolean;
    activeOnly?: boolean;
    attention?: boolean;
    limit?: number;
    trailing?: boolean;
  } = {},
): TreeNode[] {
  const all = assignments(state);
  const selected = options.selected ? assignmentKey(options.selected) : undefined;
  let chosen = all.filter((assignment) => {
    const phase = assignment.execution.phase;
    if (options.finished === false && isFinished(assignment)) return false;
    if (assignmentKey(assignment.ref) === selected) return true;
    if (options.activeOnly)
      return (
        (phase !== "queued" && phase !== "ended") ||
        Boolean(options.attention && needsAttention(state, assignment))
      );
    return options.queued || phase !== "queued";
  });

  if (options.limit) chosen = chosen.slice(0, options.limit);
  const included = new Set(chosen.map((assignment) => assignmentKey(assignment.ref)));
  for (const assignment of chosen) {
    let parent = state.workers[assignment.ref.worker].parentAssignment;
    const visited = new Set<string>();
    while (parent) {
      const key = assignmentKey(parent);
      if (visited.has(key) || !state.assignments[key]) break;
      visited.add(key);
      included.add(key);
      parent = state.workers[parent.worker]?.parentAssignment;
    }
  }
  const children = new Map<string, Assignment[]>();
  const roots: Assignment[] = [];
  for (const assignment of all) {
    if (!included.has(assignmentKey(assignment.ref))) continue;
    const parent = state.workers[assignment.ref.worker].parentAssignment;
    const key = parent ? assignmentKey(parent) : undefined;
    if (key && included.has(key) && key !== assignmentKey(assignment.ref)) {
      const siblings = children.get(key) ?? [];
      siblings.push(assignment);
      children.set(key, siblings);
    } else roots.push(assignment);
  }
  const result: TreeNode[] = [];
  const stack = roots
    .map((assignment, index) => ({
      assignment,
      ancestors: "",
      last: index === roots.length - 1 && !options.trailing,
    }))
    .reverse();
  const seen = new Set<string>();
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) continue;
    const key = assignmentKey(entry.assignment.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const descendants = children.get(key) ?? [];
    const branch = entry.last ? (options.ascii ? "`- " : "└─ ") : options.ascii ? "|- " : "├─ ";
    const continuation = entry.ancestors + (entry.last ? "   " : options.ascii ? "|  " : "│  ");
    result.push({
      assignment: entry.assignment,
      prefix: entry.ancestors + branch,
      continuation,
      hasChildren: descendants.length > 0,
    });
    for (let index = descendants.length - 1; index >= 0; index--)
      stack.push({
        assignment: descendants[index],
        ancestors: continuation,
        last: index === descendants.length - 1,
      });
  }
  return result;
}
