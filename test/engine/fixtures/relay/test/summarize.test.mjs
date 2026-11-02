import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/summarize.mjs";

function event(service, status, latencyMs) {
  return {
    service,
    at: "2024-01-02T03:04:05Z",
    status,
    latencyMs,
  };
}

test("summarize returns the empty report shape for no events", () => {
  assert.deepEqual(summarize([]), { total: 0, failures: 0, services: [] });
});

test("groups services, counts failures at 500+, and sorts by code unit", () => {
  const events = [
    event("z", 499, 4),
    event("Alpha", 500, 3),
    event("alpha", 599, 5),
    event("z", 500, 8),
    event("\uE000", 499, 1),
    event("\u{1F600}", 599, 7),
  ];

  assert.deepEqual(summarize(events), {
    total: 6,
    failures: 4,
    services: [
      { service: "Alpha", count: 1, failures: 1, errorRate: 1, p95Ms: 3 },
      { service: "alpha", count: 1, failures: 1, errorRate: 1, p95Ms: 5 },
      { service: "z", count: 2, failures: 1, errorRate: 0.5, p95Ms: 8 },
      {
        service: "\u{1F600}",
        count: 1,
        failures: 1,
        errorRate: 1,
        p95Ms: 7,
      },
      { service: "\uE000", count: 1, failures: 0, errorRate: 0, p95Ms: 1 },
    ],
  });
});

test("uses nearest-rank p95 at one-, nineteen-, and twenty-event boundaries", () => {
  const events = [event("one", 200, 42)];
  for (let latencyMs = 19; latencyMs >= 1; latencyMs -= 1) {
    events.push(event("nineteen", 200, latencyMs));
  }
  for (let latencyMs = 20; latencyMs >= 1; latencyMs -= 1) {
    events.push(event("twenty", 200, latencyMs));
  }

  const result = summarize(events);
  const byService = new Map(result.services.map((service) => [service.service, service]));

  assert.equal(result.total, 40);
  assert.equal(byService.get("one").p95Ms, 42);
  assert.equal(byService.get("nineteen").p95Ms, 19);
  // For 20 values, ceil(.95 * 20) is rank 19, not the maximum (20).
  assert.equal(byService.get("twenty").p95Ms, 19);
});

test("sorts duplicate and unsorted latencies before selecting nearest-rank p95", () => {
  const latencies = [200, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 100, 18];
  const result = summarize(latencies.map((latencyMs) => event("worker", 200, latencyMs)));

  assert.deepEqual(result.services, [
    { service: "worker", count: 21, failures: 0, errorRate: 0, p95Ms: 100 },
  ]);
});

test("does not mutate event records or reorder the caller's array", () => {
  const events = Object.freeze([
    Object.freeze(event("second", 503, 25)),
    Object.freeze(event("first", 204, 10)),
    Object.freeze(event("second", 200, 5)),
  ]);
  const before = structuredClone(events);

  assert.deepEqual(summarize(events), {
    total: 3,
    failures: 1,
    services: [
      { service: "first", count: 1, failures: 0, errorRate: 0, p95Ms: 10 },
      { service: "second", count: 2, failures: 1, errorRate: 0.5, p95Ms: 25 },
    ],
  });
  assert.deepEqual(events, before);
});
