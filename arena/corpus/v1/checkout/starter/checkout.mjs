import { priceItems } from "./items.mjs";
import { discountFor } from "./promotions.mjs";

export function quote(items, code) {
  const priced = priceItems(items);
  const discountCents = discountFor(priced.subtotalCents, code);
  throw new Error(`Integrate quote; computed discount ${discountCents}`);
}
