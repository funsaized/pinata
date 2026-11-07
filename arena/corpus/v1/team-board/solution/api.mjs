import { applyCommand } from "./store.mjs";
import { selectTickets } from "./query.mjs";
export function handleApi(state, request) {
  const error = (status, message) => ({ state, status, body: { error: message } });
  const url = new URL(request.path, "http://localhost"),
    method = request.method;
  if (url.pathname === "/api/tickets") {
    if (method === "GET") {
      try {
        return {
          state,
          status: 200,
          body: { tickets: selectTickets(state.tickets, Object.fromEntries(url.searchParams)) },
        };
      } catch {
        return error(400, "invalid_request");
      }
    }
    if (method === "POST")
      return applyCommand(state, {
        type: "create",
        draft: request.body,
        key: request.headers?.["idempotency-key"],
      });
    return error(405, "method_not_allowed");
  }
  const match = /^\/api\/tickets\/(t[1-9][0-9]*)$/.exec(url.pathname);
  if (!match) return error(404, "not_found");
  if (method === "GET") {
    const ticket = state.tickets.find((t) => t.id === match[1]);
    return ticket
      ? { state, status: 200, body: { ticket: { ...ticket } } }
      : error(404, "not_found");
  }
  if (method !== "PATCH" && method !== "DELETE") return error(405, "method_not_allowed");
  return applyCommand(state, {
    type: method === "PATCH" ? "update" : "delete",
    id: match[1],
    revision: request.body?.revision,
    patch: request.body?.patch,
  });
}
