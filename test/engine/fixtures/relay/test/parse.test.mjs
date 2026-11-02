import assert from "node:assert/strict";
import test from "node:test";

import { parseEvents } from "../src/parse.mjs";

function jsonLine(value) {
  return JSON.stringify(value);
}

const validEvent = {
  service: "checkout",
  at: "2024-03-01T12:34:56.789Z",
  status: 200,
  latencyMs: 12.5,
};

test("parses valid records, blank lines, CRLF, and a final newline", () => {
  const input = `\r\n${jsonLine(validEvent)}\r\n \t\r\n${jsonLine({
    ...validEvent,
    service: "billing",
    at: "2024-02-29T23:59:00-04:30",
    status: 599,
    latencyMs: 0,
  })}\r\n`;

  assert.deepEqual(parseEvents(input), {
    events: [
      validEvent,
      {
        service: "billing",
        at: "2024-02-29T23:59:00-04:30",
        status: 599,
        latencyMs: 0,
      },
    ],
    errors: [],
  });
});

test("preserves physical line numbers and keeps parsing after malformed records", () => {
  const input = [
    jsonLine(validEvent),
    "{not json}",
    "   ",
    jsonLine({ ...validEvent, service: "", status: 200 }),
    jsonLine({ ...validEvent, service: "search" }),
    "",
  ].join("\n");

  const result = parseEvents(input);
  assert.deepEqual(result.events, [validEvent, { ...validEvent, service: "search" }]);
  assert.deepEqual(result.errors.map(({ line }) => line), [2, 4]);
  assert.match(result.errors[0].message, /JSON/);
  assert.match(result.errors[1].message, /service/);
});

test("accepts timezone-qualified ISO timestamps and calendar leap days", () => {
  const timestamps = [
    "2024-02-29T00:00:00Z",
    "2000-02-29T23:59:59+05:30",
    "2023-12-31T23:59-0400",
    "2024-01-01T00:00+02",
  ];
  const input = timestamps.map((at) => jsonLine({ ...validEvent, at })).join("\n");

  assert.deepEqual(parseEvents(input), {
    events: timestamps.map((at) => ({ ...validEvent, at })),
    errors: [],
  });
});

test("rejects invalid, impossible, or timezone-less timestamps", () => {
  const timestamps = [
    "not-a-date",
    "2024-02-30T12:00:00Z",
    "2023-02-29T12:00:00Z",
    "2024-13-01T12:00:00Z",
    "2024-04-31T12:00:00Z",
    "2024-01-01T24:00:00Z",
    "2024-01-01T12:60:00Z",
    "2024-01-01T12:00:60Z",
    "2024-01-01T12:00:00",
    "2024-01-01T12:00:00+24:00",
  ];
  const result = parseEvents(timestamps.map((at) => jsonLine({ ...validEvent, at })).join("\n"));

  assert.deepEqual(result.events, []);
  assert.deepEqual(result.errors.map(({ line }) => line), timestamps.map((_, index) => index + 1));
  assert.ok(result.errors.every(({ message }) => /at/.test(message)));
});

test("requires an object and validates service, status, and latency without coercion", () => {
  const invalidRecords = [
    null,
    [],
    "record",
    { ...validEvent, service: "" },
    { ...validEvent, service: 42 },
    { ...validEvent, status: 99 },
    { ...validEvent, status: 600 },
    { ...validEvent, status: 200.5 },
    { ...validEvent, status: "200" },
    { ...validEvent, latencyMs: -0.1 },
    { ...validEvent, latencyMs: "12.5" },
  ];
  const lines = invalidRecords.map(jsonLine);
  lines.push('{"service":"checkout","at":"2024-03-01T12:34:56.789Z","status":200,"latencyMs":1e400}');
  const result = parseEvents(lines.join("\n"));

  assert.deepEqual(result.events, []);
  assert.equal(result.errors.length, lines.length);
  assert.deepEqual(result.errors.map(({ line }) => line), lines.map((_, index) => index + 1));
});

test("accepts numeric boundary values and emits only the public event fields", () => {
  const input = jsonLine({
    service: "api",
    at: "2024-01-01T00:00:00Z",
    status: 100,
    latencyMs: 0,
    ignored: "extra property",
  }) + "\n" + jsonLine({
    service: "api",
    at: "2024-01-01T00:00:00Z",
    status: 599,
    latencyMs: Number.MAX_VALUE,
  });

  assert.deepEqual(parseEvents(input), {
    events: [
      { service: "api", at: "2024-01-01T00:00:00Z", status: 100, latencyMs: 0 },
      { service: "api", at: "2024-01-01T00:00:00Z", status: 599, latencyMs: Number.MAX_VALUE },
    ],
    errors: [],
  });
});

test("empty and whitespace-only input returns no events or errors", () => {
  assert.deepEqual(parseEvents(""), { events: [], errors: [] });
  assert.deepEqual(parseEvents(" \t\r\n\n"), { events: [], errors: [] });
});

test("rejects non-string input rather than coercing it", () => {
  assert.throws(() => parseEvents(123), TypeError);
  assert.throws(() => parseEvents(null), TypeError);
});
