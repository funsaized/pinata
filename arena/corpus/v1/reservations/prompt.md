# Atomic stock reservations

Implement the three ESM modules without dependencies or input mutation. Throw
TypeError for the invalid inputs specified here; no error wording is required.

`catalog.mjs`: `normalizeSku(value)` accepts a string, trims its ends, converts
ASCII letters to uppercase, and returns a SKU matching `[A-Z0-9]+(-[A-Z0-9]+)*`.
Reject nonstrings and values that do not match that grammar. `loadStock(entries)`
accepts an array of `{sku, quantity}` rows, normalizes each SKU, and requires
nonnegative safe-integer quantities. Return a plain object mapping normalized
SKUs to quantities. Sum duplicate rows, retaining zero-stock entries. Reject an
unsafe sum. Empty input returns `{}`.

`reservation.mjs`: `reserve(stock, lines)` receives the canonical plain stock
object returned by loadStock and an array of `{sku, quantity}` demand rows. It must
normalize demand SKUs, require positive safe-integer quantities, and aggregate
duplicates (reject unsafe sums). An absent SKU has zero available stock. Compare
the **entire** order before deducting anything. Return
`{accepted, stock, shortages}` with a new stock object. On failure, stock remains
equal to the input and shortages lists only understocked SKUs as
`{sku, requested, available}`, sorted by ASCII SKU order. On success, deduct every
demand and return `shortages: []`. Keep zero-stock entries. Empty demand succeeds
with a copy of the original stock. Stock itself is guaranteed canonical and valid.

`replay.mjs`: `fulfill(stockEntries, orders)` loads stock and processes orders in
input order. Orders are an array of `{id, lines}`; each id must be a nonempty string
and is compared exactly, without trimming or case folding. Return
`{stock, outcomes}`. The first occurrence of each id is reserved against the
current stock, producing `{id, status: "accepted" | "rejected", shortages}`.
Every later occurrence of that id produces `{id, status: "duplicate", shortages: []}`
without reserving or inspecting its lines, even if the original was rejected.
Only accepted orders change current stock. Duplicate order rows still need a
valid id. Propagate validation errors from the other modules. An empty orders
array returns the loaded stock and empty outcomes. For example, stock A=3 with
orders x requesting A=2 and then x requesting A=2 ends with A=1 and statuses
accepted, duplicate.
