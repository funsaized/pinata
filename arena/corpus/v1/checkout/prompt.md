# Exact-cent checkout

Implement the three ESM modules without adding dependencies. Export the existing
functions with the contracts below. Inputs must not be mutated. All monetary
values in outputs are integer cents. Throw TypeError for invalid inputs described
below; no particular error text is required.

`items.mjs`: `priceItems(items)` accepts an array of objects with a nonempty string
`sku` (preserve it verbatim), integer `quantity` from 1 through 999, and string
`price`. Prices use only this decimal grammar: `0` or a nonzero digit followed by
digits, optionally followed by a decimal point and one or two digits. No signs,
whitespace, leading zeroes, exponent notation, or trailing decimal point. Convert
exactly to cents; reject values, line totals, or a combined subtotal outside the
nonnegative safe-integer range. Return `{lines, subtotalCents}`. Each line is
`{sku, quantity, unitCents, totalCents}`, in input order; keep repeated SKUs as
separate lines. Empty input returns `{lines: [], subtotalCents: 0}`.

`promotions.mjs`: `discountFor(subtotalCents, code)` accepts a nonnegative safe
integer subtotal and an optional string code (undefined means no promotion).
Trim the code and compare case-insensitively. `SAVE10` deducts ten percent, rounded
down to whole cents, capped at 500 cents. `LESS300` deducts 300 cents only when the
subtotal is at least 2000 cents. Unknown or empty codes deduct zero. Discounts can
never exceed the subtotal. Reject any other subtotal or code type.

`checkout.mjs`: `quote(items, code)` calls the two module APIs and returns
`{lines, subtotalCents, discountCents, deliveryCents, totalCents}`. Delivery costs
450 cents unless the basket is empty or the subtotal **after** discount is at
least 3000 cents, in which cases delivery is free. Total equals subtotal minus
discount plus delivery; reject an unsafe-integer total. Pass validation failures
through to callers. For example, two units priced `10.00` with `LESS300` have a
2000-cent subtotal, a 300-cent discount, 450-cent delivery, and a 2150-cent total.
