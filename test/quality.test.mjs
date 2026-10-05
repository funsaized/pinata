import test from "node:test";
import assert from "node:assert/strict";
import { candidates, retry, scoutClaims, scoreClaims } from "./quality/fixtures.mjs";
import { evaluate } from "./quality/oracle.mjs";
import path from "node:path";
import { ROOT, command } from "../lib/core.mjs";

const moduleFrom = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("independent oracle validates the reference and catches every seeded defect", async () => {
  for (const [name, source] of Object.entries(candidates)) {
    const { parseRetryAfter } = await moduleFrom(source);
    const result = evaluate(parseRetryAfter);
    if (name === "reference") assert.equal(result.passed, result.total, JSON.stringify(result));
    else
      assert(
        result.failed.some((x) => x.name === name),
        `${name}: ${JSON.stringify(result)}`,
      );
  }
});

test("factual scoring is grounded in actual execution and rejects wrong, duplicate, missing or misplaced claims", async () => {
  const { retryable, delayFromHeader, request } = await moduleFrom(retry);
  let postCalls = 0,
    finalSleeps = 0;
  const response = (status) => ({ status, headers: { get: () => "2" } });
  await request(async () => response(++postCalls === 1 ? 503 : 200), "/", { method: "POST" });
  await request(async () => response(503), "/", {
    retries: 0,
    sleep: async () => finalSleeps++,
  }).catch(() => {});
  const values = {
    status600: retryable(600),
    seconds2: delayFromHeader("2"),
    zero: delayFromHeader("0"),
    negative: delayFromHeader("-1"),
    fraction: delayFromHeader("1.5"),
    postCalls,
    finalSleeps,
  };
  assert.deepEqual(
    values,
    Object.fromEntries(Object.entries(scoutClaims).map(([k, c]) => [k, c.value])),
  );
  const brief = Object.entries(scoutClaims)
    .map(([k, c]) => `${k}=${JSON.stringify(values[k])} @ retry.mjs:${c.lines[0]}`)
    .join("\n");
  assert.equal(scoreClaims(brief).supported, 7);
  const wrong = scoreClaims(
    brief.replace("negative=-1", "negative=-1000").replace("retry.mjs:1", "retry.mjs:100"),
  );
  assert.equal(wrong.correct, 6);
  assert.equal(wrong.supported, 5);
  assert.equal(scoreClaims(brief + "\nzero=1000 @ retry.mjs:2").incorrect, 1);
  assert.equal(scoreClaims("prose without an exact claim").missing, 7);
  const drift = scoreClaims(
    brief
      .replaceAll("=", ": ")
      .replace("negative: -1", "negative: -1000")
      .replace("retry.mjs:1", "retry.mjs:1-2"),
  );
  assert.equal(drift.correct, 6);
  assert.equal(drift.incorrect, 1);
  assert.equal(drift.noncanonical, 7);
});

test("quality runner refuses live calls before reading config without spending opt-in", async () => {
  const result = await command([process.execPath, path.join(ROOT, "test/quality/live.mjs")], {
    env: {
      ...process.env,
      PINATA_LIVE_SMOKE: "",
      PINATA_LIVE_CONFIG: "/missing-approved-config.json",
    },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Live spending disabled/);
  assert(!result.stderr.includes("ENOENT"));
});
