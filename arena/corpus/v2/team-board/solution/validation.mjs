export function normalizeDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid_request");
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const assignee = value.assignee === undefined ? "" : value.assignee;
  const status = value.status === undefined ? "todo" : value.status;
  const priority = value.priority === undefined ? 1 : value.priority;
  if (
    !title ||
    title.length > 100 ||
    typeof assignee !== "string" ||
    assignee.trim().length > 40 ||
    !["todo", "doing", "done"].includes(status) ||
    !Number.isInteger(priority) ||
    priority < 0 ||
    priority > 2
  )
    throw new TypeError("invalid_request");
  return { title, assignee: assignee.trim(), status, priority };
}
