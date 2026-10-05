export const requirements = `# Evaluation fixture requirements

retry.mjs should retry only idempotent GET/HEAD requests, only HTTP 429 or 500-599, at most retries extra attempts, and never sleep when no further attempt remains. Retry-After delta-seconds are whole nonnegative seconds converted to milliseconds; zero is valid. Invalid input uses the fallback of 1000 ms.

parse.mjs must export parseRetryAfter(raw, now = Date.now()). Return milliseconds for nonnegative whole delta-seconds or a valid IMF-fixdate HTTP date (including years 0000 through 9999). Trim surrounding whitespace. Leading zeroes are allowed. A past date returns zero. Invalid input, invalid calendar dates, mismatched weekdays, non-string input, and unsafe integer millisecond values return null. Preserve inputs and keep code dependency-free.
`;

export const retry = `export const retryable = (status) => status === 429 || status >= 500;
export const delayFromHeader = (raw) => Number.parseInt(raw, 10) || 1000;
export async function request(fetchFn, url, { method = 'GET', retries = 2, sleep = async () => {} } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetchFn(url, { method });
    if (!retryable(response.status)) return response;
    await sleep(delayFromHeader(response.headers.get('Retry-After')));
  }
  throw new Error('retry attempts exhausted');
}
`;

export const brokenParser = `export function parseRetryAfter(raw, now = Date.now()) {
  return Number.parseInt(raw, 10) * 1000;
}
`;
export const visibleTests = `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryAfter } from './parse.mjs';
test('delta seconds', () => assert.equal(parseRetryAfter('2'), 2000));
`;

// The reference avoids Date.parse and Date.UTC's special treatment of years
// below 100. The oracle below uses separate, literal expected values.
function parseReference(raw, now = Date.now()) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isSafeInteger(ms) ? ms : null;
  }
  const match =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value,
    );
  if (!match) return null;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const [, weekday, day, month, year, hour, minute, second] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), months.indexOf(month), Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== months.indexOf(month) ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second) ||
    weekdays[date.getUTCDay()] !== weekday
  )
    return null;
  const ms = Math.max(0, date.getTime() - now);
  return Number.isSafeInteger(ms) ? ms : null;
}

export const referenceParser = `export ${parseReference.toString().replace("parseReference", "parseRetryAfter")}\n`;
export const candidates = {
  reference: referenceParser,
  "invalid-calendar": referenceParser.replace(
    /if \(\s*date\.getUTCFullYear\(\)[\s\S]*?\)\s*return null;/,
    "",
  ),
  "leading-zero": referenceParser.replace(
    "const value = raw.trim();",
    "const value = raw.trim();\n  if (/^0\\d+$/.test(value)) return null;",
  ),
  "small-year": referenceParser.replace(
    "date.setUTCFullYear(Number(year), months.indexOf(month), Number(day));",
    "date.setTime(Date.UTC(Number(year), months.indexOf(month), Number(day)));",
  ),
};

export const scoutClaims = {
  status600: { value: true, lines: [1] },
  seconds2: { value: 2, lines: [2] },
  zero: { value: 1000, lines: [2] },
  negative: { value: -1, lines: [2] },
  fraction: { value: 1, lines: [2] },
  postCalls: { value: 2, lines: [3, 4, 5] },
  finalSleeps: { value: 1, lines: [4, 7] },
};

export const scoutTask = `Inspect retry.mjs against README.md without editing or running code. Explain the defects, then end your brief with exactly these seven factual answer lines, one per key:
key=<JSON scalar> @ retry.mjs:<line>
Use the CURRENT implementation's actual behavior, not the expected fixed behavior.
status600: retryable(600).
seconds2: delayFromHeader('2').
zero: delayFromHeader('0').
negative: delayFromHeader('-1').
fraction: delayFromHeader('1.5').
postCalls: number of fetchFn calls for method POST, retries 2, responses 503 then 200 (headers.get always returns '2').
finalSleeps: number of sleep calls for method GET, retries 0, response 503 (headers.get returns '2'); catch any rejection.
Supply file:line evidence for each answer. Do not assert that you ran tests.
`;

export function scoreClaims(brief = "") {
  const parsed = new Map(),
    extra = [];
  for (const line of brief.split("\n")) {
    // Recognize minor format drift separately from factual mistakes. Otherwise
    // a wrong answer written with a colon would disappear as a missing claim.
    const match = /^([a-zA-Z][a-zA-Z0-9]*)\s*(=|:)\s*(.+) @ retry\.mjs:(\d+)(?:-(\d+))?\s*$/.exec(
      line.trim(),
    );
    if (!match) continue;
    const [, key, separator, raw, sourceLine, lastLine] = match;
    if (!Object.hasOwn(scoutClaims, key)) {
      extra.push(key);
      continue;
    }
    if (parsed.has(key)) {
      parsed.set(key, { duplicate: true });
      continue;
    }
    try {
      parsed.set(key, {
        value: JSON.parse(raw),
        line: Number(sourceLine),
        end: Number(lastLine ?? sourceLine),
        canonical: separator === "=" && !lastLine,
      });
    } catch {
      parsed.set(key, { malformed: true });
    }
  }
  const claims = Object.entries(scoutClaims).map(([key, expected]) => {
    const actual = parsed.get(key);
    return {
      key,
      correct: Boolean(
        actual && !actual.duplicate && !actual.malformed && Object.is(actual.value, expected.value),
      ),
      evidence: Boolean(
        actual &&
        actual.end >= actual.line &&
        actual.end <= 9 &&
        expected.lines.some((line) => line >= actual.line && line <= actual.end),
      ),
      canonical: actual?.canonical ?? false,
      expected: expected.value,
      actual: actual?.value,
      missing: !actual,
    };
  });
  return {
    total: claims.length,
    correct: claims.filter((c) => c.correct).length,
    incorrect: claims.filter((c) => !c.correct && !c.missing).length,
    missing: claims.filter((c) => c.missing).length,
    supported: claims.filter((c) => c.correct && c.evidence).length,
    noncanonical: claims.filter((c) => !c.missing && !c.canonical).length,
    extra,
    claims,
  };
}
