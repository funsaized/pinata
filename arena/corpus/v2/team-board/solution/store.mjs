import { normalizeDraft } from "./validation.mjs";
export function emptyState() {
  return { nextId: 1, tickets: [], requests: [] };
}
export function applyCommand(state, command) {
  const error = (status, message) => ({ state, status, body: { error: message } });
  if (!command || typeof command !== "object" || Array.isArray(command))
    return error(400, "invalid_request");
  if (command.type === "create") {
    let draft;
    try {
      draft = normalizeDraft(command.draft);
    } catch {
      return error(400, "invalid_request");
    }
    const key = command.key;
    if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 64))
      return error(400, "invalid_request");
    const signature = JSON.stringify(draft),
      prior = key === undefined ? undefined : state.requests.find((r) => r.key === key);
    if (prior)
      return prior.signature === signature
        ? { state, status: 200, body: { ticket: { ...prior.ticket } } }
        : error(409, "idempotency_conflict");
    if (!Number.isSafeInteger(state.nextId + 1)) return error(400, "invalid_request");
    const ticket = { id: `t${state.nextId}`, ...draft, revision: 1 };
    return {
      state: {
        nextId: state.nextId + 1,
        tickets: [...state.tickets, ticket],
        requests:
          key === undefined
            ? [...state.requests]
            : [...state.requests, { key, signature, ticket: { ...ticket } }],
      },
      status: 201,
      body: { ticket: { ...ticket } },
    };
  }
  if (
    !["update", "delete"].includes(command.type) ||
    typeof command.id !== "string" ||
    !Number.isSafeInteger(command.revision) ||
    command.revision < 1
  )
    return error(400, "invalid_request");
  const current = state.tickets.find((t) => t.id === command.id);
  if (!current) return error(404, "not_found");
  if (current.revision !== command.revision) return error(409, "revision_conflict");
  if (command.type === "delete")
    return {
      state: { ...state, tickets: state.tickets.filter((t) => t.id !== current.id) },
      status: 200,
      body: { deleted: current.id },
    };
  if (!command.patch || typeof command.patch !== "object" || Array.isArray(command.patch))
    return error(400, "invalid_request");
  let draft;
  try {
    draft = normalizeDraft({ ...current, ...command.patch });
  } catch {
    return error(400, "invalid_request");
  }
  const ticket = { id: current.id, ...draft, revision: current.revision + 1 };
  return {
    state: { ...state, tickets: state.tickets.map((t) => (t.id === ticket.id ? ticket : t)) },
    status: 200,
    body: { ticket: { ...ticket } },
  };
}
