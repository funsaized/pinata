import { renderTicket } from "./html.mjs";
export function renderBoard(tickets) {
  return tickets.length ? tickets.map(renderTicket).join("") : "<p data-empty>No tickets yet</p>";
}
