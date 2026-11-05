import assert from "node:assert/strict";
import { runOracle } from "../../oracle-harness.mjs";

await runOracle(
  process.argv[2],
  ["catalog", "reservation", "replay"],
  [
    [
      "ASCII SKU normalization",
      ({ catalog }) => {
        assert.equal(catalog.normalizeSku("  ab-09\t"), "AB-09");
        assert.equal(catalog.normalizeSku("constructor"), "CONSTRUCTOR");
      },
    ],
    [
      "invalid SKU grammar and type",
      ({ catalog }) => {
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
          assert.throws(() => catalog.normalizeSku(sku), TypeError);
        }
      },
    ],
    ["empty stock", ({ catalog }) => assert.deepEqual(catalog.loadStock([]), {})],
    [
      "stock canonicalization merges duplicates and keeps zero",
      ({ catalog }) => {
        assert.deepEqual(
          catalog.loadStock([
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
      ({ catalog }) => {
        assert.deepEqual(catalog.loadStock([{ sku: "constructor", quantity: 2 }]), {
          CONSTRUCTOR: 2,
        });
      },
    ],
    [
      "stock validation",
      ({ catalog }) => {
        for (const input of [
          null,
          {},
          [null],
          [{ sku: "A", quantity: -1 }],
          [{ sku: "A", quantity: 1.5 }],
          [{ sku: "A", quantity: "2" }],
          [{ sku: "A", quantity: Infinity }],
        ]) {
          assert.throws(() => catalog.loadStock(input), TypeError);
        }
      },
    ],
    [
      "stock safe-integer bound",
      ({ catalog }) => {
        assert.deepEqual(catalog.loadStock([{ sku: "A", quantity: 9007199254740991 }]), {
          A: 9007199254740991,
        });
        assert.throws(
          () => catalog.loadStock([{ sku: "A", quantity: 9007199254740992 }]),
          TypeError,
        );
        assert.throws(
          () =>
            catalog.loadStock([
              { sku: "A", quantity: 9007199254740991 },
              { sku: "a", quantity: 1 },
            ]),
          TypeError,
        );
      },
    ],
    [
      "stock input immutability",
      ({ catalog }) => {
        const input = Object.freeze([Object.freeze({ sku: " a ", quantity: 2 })]);
        assert.deepEqual(catalog.loadStock(input), { A: 2 });
      },
    ],
    [
      "reservation aggregates duplicate demand",
      ({ reservation }) => {
        assert.deepEqual(
          reservation.reserve({ A: 5, B: 1 }, [
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
      ({ reservation }) => {
        assert.deepEqual(
          reservation.reserve({ A: 4 }, [
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
      ({ reservation }) => {
        assert.deepEqual(
          reservation.reserve({ A: 5, B: 1 }, [
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
      ({ reservation }) => {
        assert.deepEqual(
          reservation.reserve({ Z: 1 }, [
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
      ({ reservation }) => {
        const stock = Object.freeze({ A: 0 });
        const result = reservation.reserve(stock, []);
        assert.deepEqual(result, { accepted: true, stock: { A: 0 }, shortages: [] });
        assert.notEqual(result.stock, stock);
      },
    ],
    [
      "reservation input immutability",
      ({ reservation }) => {
        const stock = Object.freeze({ A: 4 });
        const lines = Object.freeze([Object.freeze({ sku: "a", quantity: 2 })]);
        assert.deepEqual(reservation.reserve(stock, lines), {
          accepted: true,
          stock: { A: 2 },
          shortages: [],
        });
        assert.deepEqual(stock, { A: 4 });
      },
    ],
    [
      "reservation validates positive safe demand",
      ({ reservation }) => {
        for (const quantity of [0, -1, 1.5, "2", NaN, 9007199254740992]) {
          assert.throws(() => reservation.reserve({ A: 4 }, [{ sku: "A", quantity }]), TypeError);
        }
        assert.throws(() => reservation.reserve({}, null), TypeError);
        assert.throws(() => reservation.reserve({}, [null]), TypeError);
        assert.throws(
          () =>
            reservation.reserve({}, [
              { sku: "A", quantity: 9007199254740991 },
              { sku: "A", quantity: 1 },
            ]),
          TypeError,
        );
      },
    ],
    [
      "replay uses current stock after each accepted order",
      ({ replay }) => {
        assert.deepEqual(
          replay.fulfill(
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
      ({ replay }) => {
        assert.deepEqual(
          replay.fulfill(
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
      ({ replay }) => {
        assert.deepEqual(
          replay.fulfill(
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
      ({ replay }) => {
        assert.deepEqual(
          replay.fulfill(
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
      ({ replay }) => {
        assert.deepEqual(
          replay.fulfill(
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
      ({ replay }) => {
        const entries = Object.freeze([Object.freeze({ sku: "A", quantity: 2 })]);
        const orders = Object.freeze([
          Object.freeze({
            id: "x",
            lines: Object.freeze([Object.freeze({ sku: "A", quantity: 1 })]),
          }),
        ]);
        assert.deepEqual(replay.fulfill(entries, orders), {
          stock: { A: 1 },
          outcomes: [{ id: "x", status: "accepted", shortages: [] }],
        });
      },
    ],
    [
      "replay validation propagation",
      ({ replay }) => {
        for (const orders of [
          null,
          {},
          [null],
          [{ id: "", lines: [] }],
          [{ id: 1, lines: [] }],
          [{ id: "x", lines: [{ sku: "A", quantity: 0 }] }],
        ]) {
          assert.throws(() => replay.fulfill([], orders), TypeError);
        }
        assert.throws(() => replay.fulfill([{ sku: "!", quantity: 0 }], []), TypeError);
      },
    ],
  ],
);
