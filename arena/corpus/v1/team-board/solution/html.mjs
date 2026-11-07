export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
export function renderTicket(ticket) {
  return `<article data-id="${escapeHtml(ticket.id)}" data-revision="${ticket.revision}"><h3>${escapeHtml(ticket.title)}</h3><p>${escapeHtml(ticket.assignee)}</p><span data-status>${escapeHtml(ticket.status)}</span><span>Priority ${ticket.priority}</span><button type="button" data-action="advance">Advance</button><button type="button" data-action="delete">Delete</button></article>`;
}
