import { loadStock } from "./catalog.mjs";
import { reserve } from "./reservation.mjs";

export function fulfill(stockEntries, orders) {
  let stock = loadStock(stockEntries);
  if (!Array.isArray(orders)) throw new TypeError("orders must be an array");
  const seen = new Set();
  const outcomes = [];
  for (const order of orders) {
    if (
      order === null ||
      typeof order !== "object" ||
      typeof order.id !== "string" ||
      order.id.length === 0
    )
      throw new TypeError("invalid order id");
    if (seen.has(order.id)) {
      outcomes.push({ id: order.id, status: "duplicate", shortages: [] });
      continue;
    }
    seen.add(order.id);
    const reservation = reserve(stock, order.lines);
    stock = reservation.stock;
    outcomes.push({
      id: order.id,
      status: reservation.accepted ? "accepted" : "rejected",
      shortages: reservation.shortages,
    });
  }
  return { stock, outcomes };
}
