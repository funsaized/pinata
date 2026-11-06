export function normalizeSku(value) {
  if (typeof value !== "string") throw new TypeError("SKU must be a string");
  const sku = value.trim().replace(/[a-z]/g, (letter) => letter.toUpperCase());
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(sku)) throw new TypeError("invalid SKU");
  return sku;
}

export function loadStock(entries) {
  if (!Array.isArray(entries)) throw new TypeError("stock entries must be an array");
  const stock = {};
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !Number.isSafeInteger(entry.quantity) ||
      entry.quantity < 0
    )
      throw new TypeError("invalid quantity");
    const sku = normalizeSku(entry.sku);
    const quantity = (stock[sku] ?? 0) + entry.quantity;
    if (!Number.isSafeInteger(quantity)) throw new TypeError("unsafe stock sum");
    stock[sku] = quantity;
  }
  return stock;
}
