// Trusted evaluator. Never mount this file, expected answers or its seed in a contestant.
// This shipped rehearsal is public; use an unpublished task package for an actual study.
function oracle(events) {
  if (!Array.isArray(events)) throw Error();
  const names = [];
  const receipts = [];
  const statuses = {};
  for (const e of events) {
    if (!e || typeof e !== "object" || typeof e.attempt !== "string" || !e.attempt) throw Error();
    if (!names.includes(e.attempt)) names.push(e.attempt);
    if (e.type === "usage") {
      if (
        typeof e.id !== "string" ||
        !e.id ||
        !Number.isSafeInteger(e.tokens) ||
        e.tokens < 0 ||
        !Number.isSafeInteger(e.costMicros) ||
        e.costMicros < 0
      )
        throw Error();
      const old = receipts.find((r) => r.id === e.id);
      if (
        old &&
        (old.attempt !== e.attempt || old.tokens !== e.tokens || old.costMicros !== e.costMicros)
      )
        throw Error();
      if (!old) receipts.push(e);
    } else if (e.type === "settled") {
      if (!["succeeded", "failed", "cancelled"].includes(e.status)) throw Error();
      Object.defineProperty(statuses, e.attempt, {
        value: e.status,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } else throw Error();
  }
  const tokens = receipts.reduce((n, r) => n + r.tokens, 0);
  const costMicros = receipts.reduce((n, r) => n + r.costMicros, 0);
  if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(costMicros)) throw Error();
  return {
    tokens,
    costMicros,
    attempts: names.sort().map((id) => ({
      id,
      tokens: receipts.filter((r) => r.attempt === id).reduce((n, r) => n + r.tokens, 0),
      costMicros: receipts.filter((r) => r.attempt === id).reduce((n, r) => n + r.costMicros, 0),
      status: Object.hasOwn(statuses, id) ? statuses[id] : "running",
    })),
  };
}
export function prepare(seed) {
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const usage = (id, attempt, tokens, costMicros) => ({
    type: "usage",
    id,
    attempt,
    tokens,
    costMicros,
  });
  const cases = [
    [],
    null,
    {},
    [null],
    [{ type: "nope", attempt: "a" }],
    [usage("", "a", 1, 1)],
    [usage("i", "", 1, 1)],
    [usage("i", "a", -1, 1)],
    [usage("i", "a", 1.5, 1)],
    [usage("i", "a", "1", 1)],
    [usage("i", "a", 1, -1)],
    [usage("i", "a", 1, 0.5)],
    [{ type: "settled", attempt: "a", status: "wat" }],
    [usage("i", "a", 1, 1), usage("i", "b", 1, 1)],
    [usage("i", "a", Number.MAX_SAFE_INTEGER, 1), usage("j", "b", 1, 1)],
    [usage("i", "a", 1, Number.MAX_SAFE_INTEGER), usage("j", "b", 1, 1)],
    [usage("i", "__proto__", 2, 3), usage("j", "constructor", 4, 5)],
  ];
  for (let n = 0; n < 64; n++) {
    const events = [];
    for (let i = 0; i < 3 + (next() % 20); i++) {
      const attempt = `attempt-${next() % 4}`;
      const e = usage(`${n}-${i}`, attempt, next() % 1000, next() % 10000);
      events.push(e);
      if (next() % 3 === 0) events.push({ ...e, ignored: "duplicate" });
      if (next() % 2 === 0)
        events.push({
          type: "settled",
          attempt,
          status: ["succeeded", "failed", "cancelled"][next() % 3],
        });
    }
    cases.push(events);
  }
  const expected = cases.map((input) => {
    try {
      return { ok: true, value: oracle(input), mutated: false };
    } catch {
      return { ok: false };
    }
  });
  const driver = `import { readFileSync } from 'node:fs';
import { settle } from '/work/solution.mjs';
const inputs = JSON.parse(readFileSync(0, 'utf8'));
const results = inputs.map(input => {
  const before = JSON.stringify(input);
  try { const value = settle(input); return { ok: true, value, mutated: JSON.stringify(input) !== before }; }
  catch { return { ok: false }; }
});
process.stdout.write(JSON.stringify(results));`;
  return { cases, expected, driver, rubric: "repair-ledger-v1/81-cases/all-required" };
}
