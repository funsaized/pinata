import assert from "node:assert/strict";
import { runOracle } from "../../oracle-harness.mjs";

await runOracle(
  process.argv[2],
  ["catalog", "reservation", "replay"],
  [
    [
      "ASCII SKU normalization",
      async ({ catalog }) => {
        assert.equal(await catalog.normalizeSku("  ab-09\t"), "AB-09");
        assert.equal(await catalog.normalizeSku("constructor"), "CONSTRUCTOR");
      },
    ],
    [
      "invalid SKU grammar and type",
      async ({ catalog }) => {
        for (const sku of [
          "",
          " ",
          "A B",
          "-A",
          "A-",
          "A--B",
          "__proto__",
          "a_b",
          "ß",
          "é",
          1,
          null,
        ]) {
          await assert.rejects(async () => await catalog.normalizeSku(sku), TypeError);
        }
      },
    ],
    ["empty stock", async ({ catalog }) => assert.deepEqual(await catalog.loadStock([]), {})],
    [
      "stock canonicalization merges duplicates and keeps zero",
      async ({ catalog }) => {
        assert.deepEqual(
          await catalog.loadStock([
            { sku: "b", quantity: 0 },
            { sku: " a ", quantity: 2 },
            { sku: "A", quantity: 3 },
          ]),
          { B: 0, A: 5 },
        );
      },
    ],
    [
      "stock handles object-property-looking SKU",
      async ({ catalog }) => {
        assert.deepEqual(await catalog.loadStock([{ sku: "constructor", quantity: 2 }]), {
          CONSTRUCTOR: 2,
        });
      },
    ],
    [
      "stock validation",
      async ({ catalog }) => {
        for (const input of [
          null,
          {},
          [null],
          [{ sku: "A", quantity: -1 }],
          [{ sku: "A", quantity: 1.5 }],
          [{ sku: "A", quantity: "2" }],
          [{ sku: "A", quantity: Infinity }],
        ]) {
          await assert.rejects(async () => await catalog.loadStock(input), TypeError);
        }
      },
    ],
    [
      "stock safe-integer bound",
      async ({ catalog }) => {
        assert.deepEqual(await catalog.loadStock([{ sku: "A", quantity: 9007199254740991 }]), {
          A: 9007199254740991,
        });
        await assert.rejects(
          async () => await catalog.loadStock([{ sku: "A", quantity: 9007199254740992 }]),
          TypeError,
        );
        await assert.rejects(
          async () =>
            await catalog.loadStock([
              { sku: "A", quantity: 9007199254740991 },
              { sku: "a", quantity: 1 },
            ]),
          TypeError,
        );
      },
    ],
    [
      "stock input immutability",
      async ({ catalog }) => {
        const input = Object.freeze([Object.freeze({ sku: " a ", quantity: 2 })]);
        assert.deepEqual(await catalog.loadStock(input), { A: 2 });
      },
    ],
    [
      "reservation aggregates duplicate demand",
      async ({ reservation }) => {
        assert.deepEqual(
          await reservation.reserve({ A: 5, B: 1 }, [
            { sku: "a", quantity: 2 },
            { sku: " A ", quantity: 3 },
          ]),
          {
            accepted: true,
            stock: { A: 0, B: 1 },
            shortages: [],
          },
        );
      },
    ],
    [
      "reservation duplicate demand can exceed stock",
      async ({ reservation }) => {
        assert.deepEqual(
          await reservation.reserve({ A: 4 }, [
            { sku: "A", quantity: 3 },
            { sku: "a", quantity: 2 },
          ]),
          {
            accepted: false,
            stock: { A: 4 },
            shortages: [{ sku: "A", requested: 5, available: 4 }],
          },
        );
      },
    ],
    [
      "rejection is atomic across available and short lines",
      async ({ reservation }) => {
        assert.deepEqual(
          await reservation.reserve({ A: 5, B: 1 }, [
            { sku: "A", quantity: 2 },
            { sku: "B", quantity: 3 },
          ]),
          {
            accepted: false,
            stock: { A: 5, B: 1 },
            shortages: [{ sku: "B", requested: 3, available: 1 }],
          },
        );
      },
    ],
    [
      "missing stock and ASCII shortage order",
      async ({ reservation }) => {
        assert.deepEqual(
          await reservation.reserve({ Z: 1 }, [
            { sku: "z", quantity: 4 },
            { sku: "b", quantity: 3 },
            { sku: "A-1", quantity: 2 },
          ]),
          {
            accepted: false,
            stock: { Z: 1 },
            shortages: [
              { sku: "A-1", requested: 2, available: 0 },
              { sku: "B", requested: 3, available: 0 },
              { sku: "Z", requested: 4, available: 1 },
            ],
          },
        );
      },
    ],
    [
      "empty reservation returns a distinct stock object",
      async ({ reservation }) => {
        const stock = Object.freeze({ A: 0 });
        const result = await reservation.reserve(stock, []);
        assert.deepEqual(result, { accepted: true, stock: { A: 0 }, shortages: [] });
        assert.notEqual(result.stock, stock);
      },
    ],
    [
      "reservation input immutability",
      async ({ reservation }) => {
        const stock = Object.freeze({ A: 4 });
        const lines = Object.freeze([Object.freeze({ sku: "a", quantity: 2 })]);
        assert.deepEqual(await reservation.reserve(stock, lines), {
          accepted: true,
          stock: { A: 2 },
          shortages: [],
        });
        assert.deepEqual(stock, { A: 4 });
      },
    ],
    [
      "reservation validates positive safe demand",
      async ({ reservation }) => {
        for (const quantity of [0, -1, 1.5, "2", NaN, 9007199254740992]) {
          await assert.rejects(
            async () => await reservation.reserve({ A: 4 }, [{ sku: "A", quantity }]),
            TypeError,
          );
        }
        await assert.rejects(async () => await reservation.reserve({}, null), TypeError);
        await assert.rejects(async () => await reservation.reserve({}, [null]), TypeError);
        await assert.rejects(
          async () =>
            await reservation.reserve({}, [
              { sku: "A", quantity: 9007199254740991 },
              { sku: "A", quantity: 1 },
            ]),
          TypeError,
        );
      },
    ],
    [
      "replay uses current stock after each accepted order",
      async ({ replay }) => {
        assert.deepEqual(
          await replay.fulfill(
            [{ sku: " a ", quantity: 5 }],
            [
              { id: "one", lines: [{ sku: "a", quantity: 3 }] },
              { id: "two", lines: [{ sku: "A", quantity: 3 }] },
              { id: "three", lines: [{ sku: "A", quantity: 2 }] },
            ],
          ),
          {
            stock: { A: 0 },
            outcomes: [
              { id: "one", status: "accepted", shortages: [] },
              {
                id: "two",
                status: "rejected",
                shortages: [{ sku: "A", requested: 3, available: 2 }],
              },
              { id: "three", status: "accepted", shortages: [] },
            ],
          },
        );
      },
    ],
    [
      "replay duplicate accepted id ignores invalid lines",
      async ({ replay }) => {
        assert.deepEqual(
          await replay.fulfill(
            [{ sku: "A", quantity: 3 }],
            [
              { id: "x", lines: [{ sku: "A", quantity: 2 }] },
              { id: "x", lines: null },
            ],
          ),
          {
            stock: { A: 1 },
            outcomes: [
              { id: "x", status: "accepted", shortages: [] },
              { id: "x", status: "duplicate", shortages: [] },
            ],
          },
        );
      },
    ],
    [
      "replay rejected ids are also idempotent",
      async ({ replay }) => {
        assert.deepEqual(
          await replay.fulfill(
            [{ sku: "A", quantity: 1 }],
            [
              { id: "x", lines: [{ sku: "A", quantity: 2 }] },
              { id: "x", lines: [{ sku: "A", quantity: 1 }] },
            ],
          ),
          {
            stock: { A: 1 },
            outcomes: [
              {
                id: "x",
                status: "rejected",
                shortages: [{ sku: "A", requested: 2, available: 1 }],
              },
              { id: "x", status: "duplicate", shortages: [] },
            ],
          },
        );
      },
    ],
    [
      "replay order ids compare exactly",
      async ({ replay }) => {
        assert.deepEqual(
          await replay.fulfill(
            [{ sku: "A", quantity: 3 }],
            [
              { id: "x", lines: [{ sku: "A", quantity: 1 }] },
              { id: "X", lines: [{ sku: "A", quantity: 1 }] },
              { id: " x ", lines: [{ sku: "A", quantity: 1 }] },
            ],
          ),
          {
            stock: { A: 0 },
            outcomes: [
              { id: "x", status: "accepted", shortages: [] },
              { id: "X", status: "accepted", shortages: [] },
              { id: " x ", status: "accepted", shortages: [] },
            ],
          },
        );
      },
    ],
    [
      "empty replay and stock handoff",
      async ({ replay }) => {
        assert.deepEqual(
          await replay.fulfill(
            [
              { sku: "a", quantity: 2 },
              { sku: "A", quantity: 3 },
            ],
            [],
          ),
          { stock: { A: 5 }, outcomes: [] },
        );
      },
    ],
    [
      "replay input immutability",
      async ({ replay }) => {
        const entries = Object.freeze([Object.freeze({ sku: "A", quantity: 2 })]);
        const orders = Object.freeze([
          Object.freeze({
            id: "x",
            lines: Object.freeze([Object.freeze({ sku: "A", quantity: 1 })]),
          }),
        ]);
        assert.deepEqual(await replay.fulfill(entries, orders), {
          stock: { A: 1 },
          outcomes: [{ id: "x", status: "accepted", shortages: [] }],
        });
      },
    ],
    [
      "replay validation propagation",
      async ({ replay }) => {
        for (const orders of [
          null,
          {},
          [null],
          [{ id: "", lines: [] }],
          [{ id: 1, lines: [] }],
          [{ id: "x", lines: [{ sku: "A", quantity: 0 }] }],
        ]) {
          await assert.rejects(async () => await replay.fulfill([], orders), TypeError);
        }
        await assert.rejects(
          async () => await replay.fulfill([{ sku: "!", quantity: 0 }], []),
          TypeError,
        );
      },
    ],
  ],
);
