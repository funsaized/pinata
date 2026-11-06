import assert from "node:assert/strict";
import { runOracle } from "../../oracle-harness.mjs";

await runOracle(
  process.argv[2],
  ["parse", "aggregate", "report"],
  [
    [
      "parse trims service and preserves message delimiters",
      async ({ parse }) => {
        assert.deepEqual(await parse.parseLine("12|WARN| api |  retry|later  "), {
          timestamp: 12,
          level: "WARN",
          service: "api",
          message: "  retry|later  ",
        });
      },
    ],
    [
      "zero timestamp and empty message",
      async ({ parse }) => {
        assert.deepEqual(await parse.parseLine("0|INFO|worker|"), {
          timestamp: 0,
          level: "INFO",
          service: "worker",
          message: "",
        });
      },
    ],
    [
      "timestamp strict grammar",
      async ({ parse }) => {
        for (const timestamp of [
          "",
          "01",
          "-1",
          "+1",
          "1.0",
          " 1",
          "1 ",
          "1\n",
          "1\r\n",
          "1e2",
          "Infinity",
          "9007199254740992",
        ]) {
          assert.equal(await parse.parseLine(`${timestamp}|INFO|api|ok`), null);
        }
      },
    ],
    [
      "timestamp largest safe integer",
      async ({ parse }) => {
        assert.deepEqual(await parse.parseLine("9007199254740991|ERROR|api|end"), {
          timestamp: 9007199254740991,
          level: "ERROR",
          service: "api",
          message: "end",
        });
      },
    ],
    [
      "malformed line fields and types",
      async ({ parse }) => {
        for (const line of [
          null,
          1,
          {},
          "",
          "1|INFO|api",
          "1|info|api|ok",
          "1|DEBUG|api|ok",
          "1|INFO|  |ok",
          "1||api|ok",
        ]) {
          assert.equal(await parse.parseLine(line), null);
        }
      },
    ],
    [
      "empty and zero-width aggregation",
      async ({ aggregate }) => {
        assert.deepEqual(await aggregate.aggregate([], 0, 10), []);
        assert.deepEqual(
          await aggregate.aggregate(
            [{ timestamp: 5, service: "api", level: "INFO", message: "" }],
            5,
            5,
          ),
          [],
        );
      },
    ],
    [
      "half-open window boundaries",
      async ({ aggregate }) => {
        assert.deepEqual(
          await aggregate.aggregate(
            [
              { timestamp: 9, service: "api", level: "ERROR", message: "" },
              { timestamp: 10, service: "api", level: "WARN", message: "" },
              { timestamp: 19, service: "api", level: "INFO", message: "" },
              { timestamp: 20, service: "api", level: "ERROR", message: "" },
            ],
            10,
            20,
          ),
          [{ service: "api", info: 1, warn: 1, error: 0 }],
        );
      },
    ],
    [
      "case-sensitive service ordering and complete counts",
      async ({ aggregate }) => {
        assert.deepEqual(
          await aggregate.aggregate(
            [
              { timestamp: 1, service: "z", level: "INFO", message: "" },
              { timestamp: 1, service: "a", level: "WARN", message: "" },
              { timestamp: 1, service: "A", level: "ERROR", message: "" },
              { timestamp: 1, service: "a", level: "ERROR", message: "" },
            ],
            0,
            2,
          ),
          [
            { service: "A", info: 0, warn: 0, error: 1 },
            { service: "a", info: 0, warn: 1, error: 1 },
            { service: "z", info: 1, warn: 0, error: 0 },
          ],
        );
      },
    ],
    [
      "repeated events count independently",
      async ({ aggregate }) => {
        const event = Object.freeze({
          timestamp: 1,
          service: "api",
          level: "ERROR",
          message: "same",
        });
        const input = Object.freeze([event, event]);
        assert.deepEqual(await aggregate.aggregate(input, 0, 2), [
          { service: "api", info: 0, warn: 0, error: 2 },
        ]);
      },
    ],
    [
      "object-property-looking service names",
      async ({ aggregate }) => {
        assert.deepEqual(
          await aggregate.aggregate(
            [
              { timestamp: 1, service: "__proto__", level: "WARN", message: "" },
              { timestamp: 1, service: "constructor", level: "ERROR", message: "" },
            ],
            0,
            2,
          ),
          [
            { service: "__proto__", info: 0, warn: 1, error: 0 },
            { service: "constructor", info: 0, warn: 0, error: 1 },
          ],
        );
      },
    ],
    [
      "aggregation leaves frozen inputs in original order",
      async ({ aggregate }) => {
        const input = Object.freeze([
          Object.freeze({ timestamp: 1, service: "z", level: "INFO", message: "" }),
          Object.freeze({ timestamp: 1, service: "a", level: "WARN", message: "" }),
        ]);
        assert.deepEqual(await aggregate.aggregate(input, 0, 2), [
          { service: "a", info: 0, warn: 1, error: 0 },
          { service: "z", info: 1, warn: 0, error: 0 },
        ]);
        assert.equal(input[0].service, "z");
      },
    ],
    [
      "window validation on empty input",
      async ({ aggregate }) => {
        for (const [start, end] of [
          [-1, 2],
          [2, 1],
          [0, 1.5],
          ["0", 2],
          [0, Infinity],
          [NaN, 2],
          [0, 9007199254740992],
        ]) {
          await assert.rejects(async () => await aggregate.aggregate([], start, end), TypeError);
        }
      },
    ],
    [
      "empty report",
      async ({ report }) => {
        assert.deepEqual(await report.summarize([], 0, 10), {
          accepted: 0,
          malformed: 0,
          outsideWindow: 0,
          services: [],
          alerts: [],
        });
      },
    ],
    [
      "report parser and window handoff",
      async ({ report }) => {
        assert.deepEqual(
          await report.summarize(
            [
              "9|INFO|api|before",
              "10|ERROR| api |start",
              "19|ERROR|api|inside|message",
              "20|WARN|api|end",
              "garbage",
              null,
            ],
            10,
            20,
          ),
          {
            accepted: 2,
            malformed: 2,
            outsideWindow: 2,
            services: [{ service: "api", info: 0, warn: 0, error: 2 }],
            alerts: [{ service: "api", severity: "critical" }],
          },
        );
      },
    ],
    [
      "warning inclusive threshold",
      async ({ report }) => {
        assert.deepEqual(
          await report.summarize(["1|WARN|api|a", "2|WARN|api|b", "3|WARN|api|c"], 0, 4),
          {
            accepted: 3,
            malformed: 0,
            outsideWindow: 0,
            services: [{ service: "api", info: 0, warn: 3, error: 0 }],
            alerts: [{ service: "api", severity: "warning" }],
          },
        );
      },
    ],
    [
      "below-threshold services have no alert",
      async ({ report }) => {
        assert.deepEqual(
          await report.summarize(
            ["1|WARN|api|a", "2|WARN|api|b", "3|ERROR|api|c", "3|INFO|worker|ok"],
            0,
            4,
          ),
          {
            accepted: 4,
            malformed: 0,
            outsideWindow: 0,
            services: [
              { service: "api", info: 0, warn: 2, error: 1 },
              { service: "worker", info: 1, warn: 0, error: 0 },
            ],
            alerts: [],
          },
        );
      },
    ],
    [
      "critical precedence and alert ordering",
      async ({ report }) => {
        assert.deepEqual(
          await report.summarize(
            [
              "1|WARN|z|a",
              "1|WARN|z|b",
              "1|WARN|z|c",
              "1|ERROR|z|d",
              "1|ERROR|z|e",
              "1|WARN|a|a",
              "1|WARN|a|b",
              "1|WARN|a|c",
            ],
            0,
            2,
          ),
          {
            accepted: 8,
            malformed: 0,
            outsideWindow: 0,
            services: [
              { service: "a", info: 0, warn: 3, error: 0 },
              { service: "z", info: 0, warn: 3, error: 2 },
            ],
            alerts: [
              { service: "a", severity: "warning" },
              { service: "z", severity: "critical" },
            ],
          },
        );
      },
    ],
    [
      "zero-width report distinguishes malformed from outside",
      async ({ report }) => {
        assert.deepEqual(await report.summarize(["1|ERROR|api|ok", "bad"], 1, 1), {
          accepted: 0,
          malformed: 1,
          outsideWindow: 1,
          services: [],
          alerts: [],
        });
      },
    ],
    [
      "report handles frozen line list",
      async ({ report }) => {
        assert.deepEqual(await report.summarize(Object.freeze(["0|INFO|a|hello"]), 0, 1), {
          accepted: 1,
          malformed: 0,
          outsideWindow: 0,
          services: [{ service: "a", info: 1, warn: 0, error: 0 }],
          alerts: [],
        });
      },
    ],
    [
      "report validation propagation",
      async ({ report }) => {
        await assert.rejects(async () => await report.summarize(null, 0, 1), TypeError);
        await assert.rejects(async () => await report.summarize([], 2, 1), TypeError);
        await assert.rejects(async () => await report.summarize([], 0, NaN), TypeError);
      },
    ],
  ],
);
