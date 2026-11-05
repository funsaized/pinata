import assert from "node:assert/strict";
import { runOracle } from "../../oracle-harness.mjs";

await runOracle(
  process.argv[2],
  ["items", "promotions", "checkout"],
  [
    [
      "empty pricing",
      async ({ items }) => {
        assert.deepEqual(await items.priceItems([]), { lines: [], subtotalCents: 0 });
      },
    ],
    [
      "exact decimals and repeated SKU lines",
      async ({ items }) => {
        assert.deepEqual(
          await items.priceItems([
            { sku: "A", quantity: 3, price: "0.29" },
            { sku: "A", quantity: 2, price: "2.5" },
            { sku: " B ", quantity: 1, price: "0" },
          ]),
          {
            lines: [
              { sku: "A", quantity: 3, unitCents: 29, totalCents: 87 },
              { sku: "A", quantity: 2, unitCents: 250, totalCents: 500 },
              { sku: " B ", quantity: 1, unitCents: 0, totalCents: 0 },
            ],
            subtotalCents: 587,
          },
        );
      },
    ],
    [
      "maximum permitted quantity",
      async ({ items }) => {
        assert.deepEqual(await items.priceItems([{ sku: "BULK", quantity: 999, price: "0.01" }]), {
          lines: [{ sku: "BULK", quantity: 999, unitCents: 1, totalCents: 999 }],
          subtotalCents: 999,
        });
      },
    ],
    [
      "pricing leaves frozen inputs intact",
      async ({ items }) => {
        const input = Object.freeze([Object.freeze({ sku: "A", quantity: 2, price: "1.25" })]);
        const result = await items.priceItems(input);
        assert.deepEqual(result, {
          lines: [{ sku: "A", quantity: 2, unitCents: 125, totalCents: 250 }],
          subtotalCents: 250,
        });
        assert.notEqual(result.lines, input);
        assert.notEqual(result.lines[0], input[0]);
      },
    ],
    [
      "strict price grammar",
      async ({ items }) => {
        for (const price of [
          "",
          "01",
          ".50",
          "1.",
          "-1",
          "+1",
          " 1",
          "1 ",
          "1\n",
          "1.2\r\n",
          "1e2",
          "1.001",
          "Infinity",
          1,
          null,
        ]) {
          await assert.rejects(
            async () => await items.priceItems([{ sku: "A", quantity: 1, price }]),
            TypeError,
          );
        }
      },
    ],
    [
      "invalid basket and item shapes",
      async ({ items }) => {
        for (const value of [
          null,
          {},
          "",
          [null],
          Array(1),
          [{}],
          [{ sku: "", quantity: 1, price: "1" }],
          [{ sku: 3, quantity: 1, price: "1" }],
        ]) {
          await assert.rejects(async () => await items.priceItems(value), TypeError);
        }
      },
    ],
    [
      "quantity range and type",
      async ({ items }) => {
        for (const quantity of [0, -1, 1.5, 1000, "2", NaN, Infinity]) {
          await assert.rejects(
            async () => await items.priceItems([{ sku: "A", quantity, price: "1" }]),
            TypeError,
          );
        }
      },
    ],
    [
      "safe-integer exact price boundary",
      async ({ items }) => {
        assert.deepEqual(
          await items.priceItems([{ sku: "MAX", quantity: 1, price: "90071992547409.91" }]),
          {
            lines: [
              {
                sku: "MAX",
                quantity: 1,
                unitCents: 9007199254740991,
                totalCents: 9007199254740991,
              },
            ],
            subtotalCents: 9007199254740991,
          },
        );
        await assert.rejects(
          async () =>
            await items.priceItems([{ sku: "MAX", quantity: 1, price: "90071992547409.92" }]),
          TypeError,
        );
      },
    ],
    [
      "unsafe line and basket totals",
      async ({ items }) => {
        await assert.rejects(
          async () =>
            await items.priceItems([{ sku: "A", quantity: 2, price: "45035996273704.96" }]),
          TypeError,
        );
        await assert.rejects(
          async () =>
            await items.priceItems([
              { sku: "A", quantity: 1, price: "90071992547409.91" },
              { sku: "B", quantity: 1, price: "0.01" },
            ]),
          TypeError,
        );
      },
    ],
    [
      "promotion rounding down",
      async ({ promotions }) => {
        assert.equal(await promotions.discountFor(1999, "SAVE10"), 199);
        assert.equal(await promotions.discountFor(9, "SAVE10"), 0);
      },
    ],
    [
      "promotion cap and normalization",
      async ({ promotions }) => {
        assert.equal(await promotions.discountFor(8000, "  save10\t"), 500);
        assert.equal(await promotions.discountFor(0, "SAVE10"), 0);
      },
    ],
    [
      "fixed promotion inclusive threshold",
      async ({ promotions }) => {
        assert.equal(await promotions.discountFor(1999, "LESS300"), 0);
        assert.equal(await promotions.discountFor(2000, "less300"), 300);
      },
    ],
    [
      "absent and unknown promotions",
      async ({ promotions }) => {
        assert.equal(await promotions.discountFor(2500), 0);
        assert.equal(await promotions.discountFor(2500, "   "), 0);
        assert.equal(await promotions.discountFor(2500, "UNKNOWN"), 0);
      },
    ],
    [
      "invalid promotion inputs",
      async ({ promotions }) => {
        for (const subtotal of [-1, 1.5, "10", NaN, Infinity, 9007199254740992]) {
          await assert.rejects(
            async () => await promotions.discountFor(subtotal, "SAVE10"),
            TypeError,
          );
        }
        for (const code of [null, 10, {}, []])
          await assert.rejects(async () => await promotions.discountFor(2000, code), TypeError);
      },
    ],
    [
      "empty checkout has no delivery",
      async ({ checkout }) => {
        assert.deepEqual(await checkout.quote([], "SAVE10"), {
          lines: [],
          subtotalCents: 0,
          discountCents: 0,
          deliveryCents: 0,
          totalCents: 0,
        });
      },
    ],
    [
      "checkout module handoff",
      async ({ checkout }) => {
        assert.deepEqual(
          await checkout.quote([{ sku: "A", quantity: 2, price: "10.00" }], "LESS300"),
          {
            lines: [{ sku: "A", quantity: 2, unitCents: 1000, totalCents: 2000 }],
            subtotalCents: 2000,
            discountCents: 300,
            deliveryCents: 450,
            totalCents: 2150,
          },
        );
      },
    ],
    [
      "delivery threshold uses discounted subtotal",
      async ({ checkout }) => {
        assert.deepEqual(
          await checkout.quote([{ sku: "A", quantity: 1, price: "30.00" }], "SAVE10"),
          {
            lines: [{ sku: "A", quantity: 1, unitCents: 3000, totalCents: 3000 }],
            subtotalCents: 3000,
            discountCents: 300,
            deliveryCents: 450,
            totalCents: 3150,
          },
        );
      },
    ],
    [
      "delivery threshold equality is free",
      async ({ checkout }) => {
        assert.deepEqual(
          await checkout.quote([{ sku: "A", quantity: 1, price: "33.00" }], "LESS300"),
          {
            lines: [{ sku: "A", quantity: 1, unitCents: 3300, totalCents: 3300 }],
            subtotalCents: 3300,
            discountCents: 300,
            deliveryCents: 0,
            totalCents: 3000,
          },
        );
      },
    ],
    [
      "zero-price item is still a nonempty basket",
      async ({ checkout }) => {
        assert.deepEqual(await checkout.quote([{ sku: "FREE", quantity: 1, price: "0.00" }]), {
          lines: [{ sku: "FREE", quantity: 1, unitCents: 0, totalCents: 0 }],
          subtotalCents: 0,
          discountCents: 0,
          deliveryCents: 450,
          totalCents: 450,
        });
      },
    ],
    [
      "checkout validation propagation",
      async ({ checkout }) => {
        await assert.rejects(
          async () => await checkout.quote([{ sku: "A", quantity: 0, price: "1" }]),
          TypeError,
        );
        await assert.rejects(async () => await checkout.quote([], null), TypeError);
      },
    ],
  ],
);
