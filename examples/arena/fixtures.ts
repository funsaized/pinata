// Deterministic candidates are operator fixtures, never included in public contestant mounts.
// They exercise the harness and grader; they are not outputs of the named live products.
export type Fixture =
  | "good"
  | "bad"
  | "failed"
  | "timeout"
  | "cancelled"
  | "unmetered"
  | "escape"
  | "mutating";
function implementation(events: any) {
  if (!Array.isArray(events)) throw Error();
  const attempts = new Map();
  const seen = new Map();
  let tokens = 0;
  let costMicros = 0;
  for (const e of events) {
    if (!e || typeof e.attempt !== "string" || !e.attempt) throw Error();
    const a = attempts.get(e.attempt) ?? {
      id: e.attempt,
      tokens: 0,
      costMicros: 0,
      status: "running",
    };
    attempts.set(e.attempt, a);
    if (e.type === "settled") {
      if (!["succeeded", "failed", "cancelled"].includes(e.status)) throw Error();
      a.status = e.status;
    } else if (e.type === "usage") {
      if (
        typeof e.id !== "string" ||
        !e.id ||
        ![e.tokens, e.costMicros].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw Error();
      const receipt = JSON.stringify([e.attempt, e.tokens, e.costMicros]);
      if (seen.has(e.id)) {
        if (seen.get(e.id) !== receipt) throw Error();
        continue;
      }
      seen.set(e.id, receipt);
      a.tokens += e.tokens;
      a.costMicros += e.costMicros;
      tokens += e.tokens;
      costMicros += e.costMicros;
      if (![tokens, costMicros, a.tokens, a.costMicros].every(Number.isSafeInteger)) throw Error();
    } else throw Error();
  }
  return {
    tokens,
    costMicros,
    attempts: [...attempts.keys()].sort().map((id) => attempts.get(id)),
  };
}
export function fixtureSource(fixture: Fixture): string {
  if (fixture === "bad")
    return `export function settle(events) {\n  if (!Array.isArray(events)) throw Error();\n  const last = events.filter(e => e?.type === 'usage').at(-1);\n  return {tokens:last?.tokens??0,costMicros:last?.costMicros??0,attempts:last?[{id:last.attempt,tokens:last.tokens,costMicros:last.costMicros,status:'succeeded'}]:[]};\n}\n`;
  if (fixture === "timeout") return "export function settle() { while (true) {} }\n";
  if (fixture === "escape")
    return `import fs from 'node:fs';\nexport function settle() { return {hostHome:fs.existsSync('/home/agent'), socket:fs.existsSync('/var/run/docker.sock'), oracle:fs.existsSync('/arena/grading.mjs'), host:fs.existsSync('/workspace')}; }\n`;
  if (fixture === "mutating")
    return `export ${implementation.toString()}\nexport function settle(events) { try { return implementation(events); } catch { if (Array.isArray(events)) events.length = 0; throw Error(); } }\n`;
  return `export ${implementation.toString()}\nexport const settle = implementation;\n`;
}
export function seededFixtures(seed: number, scenario: "clean" | "faults"): Fixture[] {
  if (scenario === "clean") return ["good", "good", "good"];
  const fixtures: Fixture[] = ["good", "bad", "timeout"];
  const shift = (seed >>> 0) % 3;
  return fixtures.map((_, i) => fixtures[(i + shift) % 3]);
}
