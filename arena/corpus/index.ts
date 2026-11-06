import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ArenaTask } from "../types.ts";

const definitions = [
  {
    id: "checkout",
    oracleCaseCount: 20,
    title: "Exact-cent checkout with promotions and delivery",
    units: [
      {
        id: "prices",
        files: ["items.mjs"],
        prompt:
          "Implement priceItems, including exact decimal parsing, validation, and immutable line output.",
      },
      {
        id: "promotions",
        files: ["promotions.mjs"],
        prompt:
          "Implement discountFor using the published promotion, threshold, and rounding contracts.",
      },
      {
        id: "integration",
        files: ["checkout.mjs"],
        prompt:
          "Integrate pricing and discounts in quote, applying delivery to the discounted subtotal and preserving the public result shape.",
      },
    ],
  },
  {
    id: "reservations",
    oracleCaseCount: 22,
    title: "Atomic stock reservations with idempotent order replay",
    units: [
      {
        id: "catalog",
        files: ["catalog.mjs"],
        prompt:
          "Implement canonical SKU validation and stock loading, including duplicate stock rows.",
      },
      {
        id: "reservation",
        files: ["reservation.mjs"],
        prompt:
          "Implement duplicate-demand aggregation, sorted shortages, and atomic immutable reservations using the catalog contract.",
      },
      {
        id: "integration",
        files: ["replay.mjs"],
        prompt:
          "Integrate stock loading and reservations in fulfill, maintaining order, current stock, and first-seen order-id idempotency.",
      },
    ],
  },
  {
    id: "incidents",
    oracleCaseCount: 20,
    title: "Windowed incident summaries from delimited logs",
    units: [
      {
        id: "parser",
        files: ["parse.mjs"],
        prompt:
          "Implement strict log parsing, retaining message delimiters and returning null for malformed records.",
      },
      {
        id: "aggregation",
        files: ["aggregate.mjs"],
        prompt:
          "Implement immutable half-open time-window aggregation with deterministic service ordering and complete level counts.",
      },
      {
        id: "integration",
        files: ["report.mjs"],
        prompt:
          "Integrate parsing and aggregation in summarize, distinguishing malformed and outside-window lines, and deriving threshold-based alerts.",
      },
    ],
  },
];

export const tasks: ArenaTask[] = definitions.map(({ id, title, units, oracleCaseCount }) => {
  const directory = new URL(`./v1/${id}/`, import.meta.url);
  return {
    id,
    version: 1,
    title,
    prompt: readFileSync(new URL("prompt.md", directory), "utf8"),
    starterDir: fileURLToPath(new URL("starter/", directory)),
    solutionDir: fileURLToPath(new URL("solution/", directory)),
    oracleFile: fileURLToPath(new URL("oracle.mjs", directory)),
    oracleCaseCount,
    units,
  };
});
