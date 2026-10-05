import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Expectations are literal and independent of the candidate/reference code.
const now = 1_893_456_000_000; // 2030-01-01T00:00:00Z
export const cases = [
  ["zero", "0", 0],
  ["seconds", "2", 2000],
  ["trim", " 2 ", 2000],
  ["leading-zero", "002", 2000],
  ["future-date", "Tue, 01 Jan 2030 00:00:02 GMT", 2000],
  ["past-date", "Wed, 01 Jan 2020 00:00:00 GMT", 0],
  ["null", null, null],
  ["undefined", undefined, null],
  ["empty", "", null],
  ["blank", " ", null],
  ["number", 2, null],
  ["negative", "-1", null],
  ["fraction", "1.5", null],
  ["suffix", "2seconds", null],
  ["plus", "+2", null],
  ["junk", "junk", null],
  ["overflow", "9007199254741", null],
  ["max-safe", "9007199254740", 9_007_199_254_740_000],
  ["invalid-calendar", "Sat, 30 Feb 2030 00:00:00 GMT", null],
  ["mismatched-weekday", "Mon, 01 Jan 2030 00:00:00 GMT", null],
  ["invalid-hour", "Tue, 01 Jan 2030 24:00:00 GMT", null],
  ["not-http-date", "2030-01-01", null],
  ["NaN", "NaN", null],
  ["Infinity", "Infinity", null],
  ["small-year", "Mon, 01 Jan 0001 00:00:00 GMT", 31_622_400_000, -62_167_219_200_000],
  ["small-year-invalid-calendar", "Thu, 29 Feb 0001 00:00:00 GMT", null, -62_167_219_200_000],
  ["leap-date", "Tue, 29 Feb 2000 00:00:00 GMT", 0],
  ["non-leap-century", "Mon, 29 Feb 2100 00:00:00 GMT", null],
];

export function evaluate(parse) {
  const results = cases.map(([name, input, expected, clock = now]) => {
    try {
      const actual = parse(input, clock);
      return { name, passed: Object.is(actual, expected), actual, expected };
    } catch (e) {
      return { name, passed: false, error: e.message, expected };
    }
  });
  return {
    passed: results.filter((x) => x.passed).length,
    total: results.length,
    failed: results.filter((x) => !x.passed),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { parseRetryAfter } = await import(pathToFileURL(path.join(process.argv[2], "parse.mjs")));
  console.log(JSON.stringify(evaluate(parseRetryAfter)));
}
