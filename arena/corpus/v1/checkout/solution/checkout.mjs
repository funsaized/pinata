import { priceItems } from "./items.mjs";
import { discountFor } from "./promotions.mjs";

export function quote(items, code) {
  const { lines, subtotalCents } = priceItems(items);
  const discountCents = discountFor(subtotalCents, code);
  const netCents = subtotalCents - discountCents;
  const deliveryCents = lines.length === 0 || netCents >= 3000 ? 0 : 450;
  const totalCents = netCents + deliveryCents;
  if (!Number.isSafeInteger(totalCents)) throw new TypeError("unsafe checkout total");
  return { lines, subtotalCents, discountCents, deliveryCents, totalCents };
}
