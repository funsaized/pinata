import { normalizeDraft } from "./validation.mjs";
export function decodeState(text) {
  try {
    const state = JSON.parse(text);
    if (
      !state ||
      !Number.isSafeInteger(state.nextId) ||
      state.nextId < 1 ||
      !Array.isArray(state.tickets) ||
      !Array.isArray(state.requests)
    )
      throw new Error();
    const ids = new Set();
    const tickets = state.tickets.map((t) => {
      if (
        !t ||
        typeof t.id !== "string" ||
        !/^t[1-9][0-9]*$/.test(t.id) ||
        !Number.isSafeInteger(Number(t.id.slice(1))) ||
        Number(t.id.slice(1)) >= state.nextId ||
        ids.has(t.id) ||
        !Number.isSafeInteger(t.revision) ||
        t.revision < 1
      )
        throw new Error();
      ids.add(t.id);
      return { id: t.id, ...normalizeDraft(t), revision: t.revision };
    });
    const keys = new Set();
    for (const r of state.requests) {
      if (
        !r ||
        typeof r.key !== "string" ||
        !r.key.trim() ||
        r.key.length > 64 ||
        keys.has(r.key) ||
        !r.ticket ||
        typeof r.ticket.id !== "string" ||
        !/^t[1-9][0-9]*$/.test(r.ticket.id) ||
        !Number.isSafeInteger(Number(r.ticket.id.slice(1))) ||
        Number(r.ticket.id.slice(1)) >= state.nextId ||
        r.ticket.revision !== 1 ||
        r.signature !== JSON.stringify(normalizeDraft(r.ticket))
      )
        throw new Error();
      keys.add(r.key);
    }
    return {
      nextId: state.nextId,
      tickets,
      requests: state.requests.map((r) => ({
        key: r.key,
        signature: r.signature,
        ticket: { id: r.ticket.id, ...normalizeDraft(r.ticket), revision: 1 },
      })),
    };
  } catch {
    throw new TypeError("invalid_state");
  }
}
export function encodeState(state) {
  return JSON.stringify(decodeState(JSON.stringify(state)));
}
