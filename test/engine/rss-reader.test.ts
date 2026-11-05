import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { persistentWindowsRssReader } from "../../bench/rss-reader.ts";
import { tempDir } from "./helpers.ts";

// Exercise the real child-process/JSON-lines path on every OS, without needing
// PowerShell. Windows also runs the actual PowerShell/.NET implementation below.
const FIXTURE = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [mode, log] = process.argv.slice(1);
const record = (value) => appendFileSync(log, JSON.stringify(value) + '\n');
record({ pid: process.pid });
if (mode === 'startup-exit') {
  process.stderr.write('x'.repeat(9000));
  process.exit(2);
}
if (mode === 'startup-hang') setInterval(() => {}, 1000);
else {
  const ready = () => console.log(JSON.stringify({ type: 'ready', protocol: mode === 'bad-ready' ? 99 : 1 }));
  if (mode === 'split-startup-delay') setTimeout(ready, 600);
  else ready();
}
let requests = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const query = JSON.parse(line);
  record(query);
  requests++;
  const response = { id: query.id, samples: Object.fromEntries(query.pids.map((pid) => [pid, pid === 2147483647 ? null : 128 * 1048576])) };
  if (requests === 1 && mode === 'bad-warm') response.samples = Object.fromEntries(query.pids.map((pid) => [pid, null]));
  if (requests > 1) {
    if (mode === 'malformed') return console.log('{');
    if (mode === 'wrong-id') response.id++;
    if (mode === 'missing') response.samples = {};
    if (mode === 'invalid-bytes') response.samples[query.pids[0]] = -1;
    if (mode === 'oversized') return process.stdout.write('x'.repeat(70000));
    if (mode === 'query-exit') return process.exit(3);
    if (mode === 'query-hang') return;
  }
  const output = JSON.stringify(response) + '\n';
  if (mode === 'slow-warm') {
    setTimeout(() => process.stdout.write(output), 350);
    return;
  }
  if (mode === 'split-startup-delay') {
    setTimeout(() => process.stdout.write(output), 600);
    return;
  }
  if (mode === 'fragmented') {
    process.stdout.write(output.slice(0, 8));
    setTimeout(() => process.stdout.write(output.slice(8)), 10);
  } else console.log(JSON.stringify(response));
  if (requests > 1 && mode === 'idle-exit') setTimeout(() => process.exit(3), 10);
  if (requests > 1 && mode === 'idle-malformed') setTimeout(() => console.log('{'), 10);
});
if (mode === 'close-hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
`;

const fixture = (mode: string, log: string) => ({
  command: [process.execPath, "--input-type=module", "-e", FIXTURE, mode, log],
  startupTimeoutMs: 3000,
  requestTimeoutMs: 300,
  closeTimeoutMs: 100,
});

async function records(
  log: string,
): Promise<Array<{ pid?: number; id?: number; pids?: number[] }>> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function assertStopped(log: string) {
  const pid = (await records(log))[0]?.pid;
  if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("persistent RSS reader warms the actual query and serializes rapid fragmented responses", async (t) => {
  const log = join(await tempDir(t, "pinata-rss-reader-"), "requests.jsonl");
  const reader = await persistentWindowsRssReader(fixture("fragmented", log));
  t.after(() => reader.close());
  assert.equal(reader.method, "windows-persistent-dotnet-working-set-v1");
  assert.deepEqual(
    (await records(log))[1]?.pids,
    [process.pid],
    "warm-up must read the actual host PID before returning",
  );
  assert.deepEqual(await reader.read([]), new Map());
  const samples = await Promise.all([
    reader.read([101]),
    reader.read([102, 103]),
    reader.read([104, 104, 2147483647]),
  ]);
  assert.deepEqual(samples, [
    new Map([[101, 128]]),
    new Map([
      [102, 128],
      [103, 128],
    ]),
    new Map([
      [104, 128],
      [2147483647, null],
    ]),
  ]);
  assert.deepEqual(
    (await records(log)).slice(1).map((item) => item.id),
    [1, 2, 3, 4],
  );
  await reader.close();
  await assertStopped(log);
  await assert.rejects(reader.read([101]), /closed/);
});

test("persistent RSS reader fails closed on malformed, mismatched, oversized, exited and timed-out queries", async (t) => {
  const dir = await tempDir(t, "pinata-rss-failures-");
  for (const mode of [
    "malformed",
    "wrong-id",
    "missing",
    "invalid-bytes",
    "oversized",
    "query-exit",
    "query-hang",
  ]) {
    const log = join(dir, `${mode}.jsonl`);
    const reader = await persistentWindowsRssReader(fixture(mode, log));
    await assert.rejects(reader.read([101]), /RSS reader/);
    await assert.rejects(
      reader.read([102]),
      /RSS reader/,
      "a broken reader must not restart or silently fall back",
    );
    await assert.rejects(reader.close(), /RSS reader/);
    await assertStopped(log);
  }
});

test("first RSS query uses the startup budget while measured queries keep the shorter deadline", async (t) => {
  const log = join(await tempDir(t, "pinata-rss-warm-budget-"), "requests.jsonl");
  const reader = await persistentWindowsRssReader({
    ...fixture("slow-warm", log),
    requestTimeoutMs: 100,
  });
  assert.deepEqual((await records(log))[1]?.pids, [process.pid]);
  // The 350 ms warm-up passed a 100 ms normal query deadline. Subsequent queries
  // still fail at that normal deadline instead of inheriting the startup budget.
  await assert.rejects(reader.read([101]), /RSS reader request 2 timed out/);
  await assert.rejects(reader.close(), /RSS reader request 2 timed out/);
  await assertStopped(log);
});

test("RSS handshake and first query share one bounded startup deadline", async (t) => {
  const log = join(await tempDir(t, "pinata-rss-shared-deadline-"), "requests.jsonl");
  await assert.rejects(
    persistentWindowsRssReader({
      ...fixture("split-startup-delay", log),
      startupTimeoutMs: 1000,
      requestTimeoutMs: 5000,
    }),
    /RSS reader (startup|request 1) timed out/,
  );
  await assertStopped(log);
});

test("persistent RSS teardown reports failures after the final successful read", async (t) => {
  const dir = await tempDir(t, "pinata-rss-idle-");
  for (const mode of ["idle-exit", "idle-malformed"]) {
    const log = join(dir, `${mode}.jsonl`);
    const reader = await persistentWindowsRssReader(fixture(mode, log));
    assert.equal((await reader.read([101])).get(101), 128);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await assert.rejects(reader.close(), /RSS reader/);
    await assertStopped(log);
  }
});

test("persistent RSS startup and actual working-set warm-up failures clean up their helper", async (t) => {
  const dir = await tempDir(t, "pinata-rss-startup-");
  for (const mode of ["startup-exit", "startup-hang", "bad-ready", "bad-warm"]) {
    const log = join(dir, `${mode}.jsonl`);
    await assert.rejects(
      persistentWindowsRssReader({
        ...fixture(mode, log),
        startupTimeoutMs: mode === "startup-hang" ? 100 : 3000,
      }),
      (error: Error) => {
        assert.match(error.message, /RSS reader/);
        assert(error.message.length < 5000, "stderr diagnostics must stay bounded");
        return true;
      },
    );
    await assertStopped(log);
  }
});

test("persistent RSS close has a bounded kill fallback and rejects invalid PID input", async (t) => {
  const log = join(await tempDir(t, "pinata-rss-close-"), "requests.jsonl");
  const reader = await persistentWindowsRssReader(fixture("close-hang", log));
  for (const pid of [0, -1, NaN, Infinity, 1.5])
    await assert.rejects(reader.read([pid]), /positive integer PIDs/);
  await reader.close();
  await reader.close();
  await assertStopped(log);
});

test(
  "Windows persistent PowerShell reader returns live and missing working sets",
  { skip: process.platform !== "win32" },
  async (t) => {
    const reader = await persistentWindowsRssReader();
    t.after(() => reader.close());
    for (let round = 0; round < 5; round++) {
      const samples = await reader.read([process.pid, 2147483647]);
      assert((samples.get(process.pid) ?? 0) > 0);
      assert.equal(samples.get(2147483647), null);
    }
    await reader.close();
  },
);
