import { normalizeSku } from "./catalog.mjs";

export function reserve(stock, lines) {
  if (!Array.isArray(lines)) throw new TypeError("demand must be an array");
  const demand = {};
  for (const line of lines) {
    if (
      line === null ||
      typeof line !== "object" ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0
    )
      throw new TypeError("invalid demand");
    const sku = normalizeSku(line.sku);
    const quantity = (demand[sku] ?? 0) + line.quantity;
    if (!Number.isSafeInteger(quantity)) throw new TypeError("unsafe demand sum");
    demand[sku] = quantity;
  }
  const shortages = Object.keys(demand)
    .sort()
    .filter((sku) => demand[sku] > (stock[sku] ?? 0))
    .map((sku) => ({ sku, requested: demand[sku], available: stock[sku] ?? 0 }));
  const next = { ...stock };
  if (shortages.length > 0) return { accepted: false, stock: next, shortages };
  for (const [sku, quantity] of Object.entries(demand)) next[sku] -= quantity;
  return { accepted: true, stock: next, shortages: [] };
}
