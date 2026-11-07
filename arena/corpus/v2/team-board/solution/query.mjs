export function selectTickets(tickets, query = {}) {
  const search = String(query.search ?? "")
      .trim()
      .toLowerCase(),
    status = query.status ?? "all";
  if (!["all", "todo", "doing", "done"].includes(status)) throw new TypeError("invalid_request");
  return tickets
    .filter(
      (t) =>
        (status === "all" || t.status === status) &&
        `${t.title} ${t.assignee}`.toLowerCase().includes(search),
    )
    .sort((a, b) => b.priority - a.priority || Number(a.id.slice(1)) - Number(b.id.slice(1)))
    .map((t) => ({ ...t }));
}
