// Explicit conversion preserves intent as instructions, never as enforcement claims.
import { checkedKeys } from "../core/validate.ts";
export interface Conversion {
  value: Record<string, unknown>;
  notices: string[];
}
export function convertInput(input: unknown): Conversion {
  checkedKeys(input, Object.keys((input as object) ?? {}), "migration input");
  const value = structuredClone(input);
  const notices: string[] = [];
  const retire = (object: Record<string, unknown>, keys: string[], where: string) => {
    for (const key of keys)
      if (Object.hasOwn(object, key)) {
        delete object[key];
        notices.push(`${where}.${key} removed; it is no longer enforced.`);
      }
  };
  const config = (object: Record<string, unknown>, where: string) =>
    retire(object, ["limits", "reviewPolicy", "deadlineAt", "workspaceReuse"], where);
  if (typeof value.name === "string" && Array.isArray(value.tools)) {
    const oldWorkspace = value.workspace;
    value.schemaVersion = 2;
    value.access = oldWorkspace === "worktree" ? "write" : "read";
    value.workspace = oldWorkspace === "worktree" ? "worktree" : "shared";
    notices.push(
      "Definition access converted separately from isolation; read-only access is preserved.",
    );
  } else if (Array.isArray(value.tasks)) {
    value.schemaVersion = 3;
    for (const [i, raw] of value.tasks.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error(`Invalid task ${i}`);
      const task = raw as Record<string, unknown>;
      const notes = Array.isArray(task.instructions) ? task.instructions : [];
      for (const key of ["checks", "evidenceChecks"])
        if (Array.isArray(task[key]))
          for (const check of task[key])
            notes.push(
              `Requested check (coordinator decides when to run it): ${JSON.stringify(check)}`,
            );
      if (Array.isArray(task.ownership) && task.ownership.length)
        notes.push(
          `Assigned file responsibility: ${task.ownership.join(", ")}. Preserve unrelated work.`,
        );
      if (task.role && !task.agent) task.agent = task.role;
      delete task.role;
      if (!task.workspace && task.agent === "builder") task.workspace = "worktree";
      task.instructions = notes;
      retire(
        task,
        ["checks", "evidenceChecks", "ownership", "noChecksReason", "limits", "deadlineAt"],
        `tasks[${i}]`,
      );
    }
    if (Array.isArray(value.integratedChecks))
      value.instructions = [
        ...(Array.isArray(value.instructions) ? value.instructions : []),
        `Coordinator destination check intent (not engine-enforced): ${JSON.stringify(value.integratedChecks)}`,
      ];
    retire(
      value,
      ["integratedChecks", "noIntegratedChecksReason", "limits", "deadlineAt", "reviewPolicy"],
      "job",
    );
    if (value.integration === "on-success") {
      value.integration = "manual";
      notices.push(
        "Automatic verified integration retired; apply isolated snapshots explicitly after inspection.",
      );
    }
    if (value.config && typeof value.config === "object")
      config(value.config as Record<string, unknown>, "config");
  } else config(value, "config");
  return { value, notices };
}
