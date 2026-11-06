export function priceItems(items) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  let subtotalCents = 0;
  const lines = Array.from(items, (item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof item.sku !== "string" ||
      item.sku.length === 0 ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 999 ||
      typeof item.price !== "string" ||
      item.price.trim() !== item.price ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(item.price)
    )
      throw new TypeError("invalid item");
    const [whole, fraction = ""] = item.price.split(".");
    const exact = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("unsafe price");
    const unitCents = Number(exact);
    const totalCents = unitCents * item.quantity;
    subtotalCents += totalCents;
    if (!Number.isSafeInteger(totalCents) || !Number.isSafeInteger(subtotalCents)) {
      throw new TypeError("unsafe total");
    }
    return { sku: item.sku, quantity: item.quantity, unitCents, totalCents };
  });
  return { lines, subtotalCents };
}
