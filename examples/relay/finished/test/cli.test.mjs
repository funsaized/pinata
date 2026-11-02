import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/relay.mjs", import.meta.url));

async function makeTempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), "relay-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test("reads one UTF-8 file and prints a complete sorted report", async (t) => {
  const directory = await makeTempDir(t);
  const inputPath = join(directory, "events with spaces.jsonl");
  await writeFile(
    inputPath,
    [
      JSON.stringify({ service: "checkout", at: "2024-03-01T12:34:56Z", status: 200, latencyMs: 10 }),
      JSON.stringify({ service: "checkout", at: "2024-03-01T12:35:56Z", status: 503, latencyMs: 20 }),
      JSON.stringify({ service: "api", at: "2024-03-01T12:36:56Z", status: 404, latencyMs: 3 }),
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runCli([inputPath], directory);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    "# Relay incident report\n" +
      "\n" +
      "Events: 3 | Failures: 1 | Invalid lines: 0\n" +
      "\n" +
      "| Service | Events | Failures | Error rate | p95 (ms) |\n" +
      "| --- | ---: | ---: | ---: | ---: |\n" +
      "| api | 1 | 0 | 0.0% | 3.0 |\n" +
      "| checkout | 2 | 1 | 50.0% | 20.0 |\n",
  );
});

test("accepts an empty file and exits successfully with the empty report", async (t) => {
  const directory = await makeTempDir(t);
  const inputPath = join(directory, "empty.jsonl");
  await writeFile(inputPath, "", "utf8");

  const result = runCli([inputPath], directory);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    "# Relay incident report\n" +
      "\n" +
      "Events: 0 | Failures: 0 | Invalid lines: 0\n" +
      "\n" +
      "| Service | Events | Failures | Error rate | p95 (ms) |\n" +
      "| --- | ---: | ---: | ---: | ---: |\n" +
      "No valid events.\n",
  );
  assert.ok(!result.stdout.endsWith("\n\n"));
});

test("reports invalid records but retains valid records and exits with code 1", async (t) => {
  const directory = await makeTempDir(t);
  const inputPath = join(directory, "mixed.jsonl");
  const goodEvent = JSON.stringify({
    service: "api",
    at: "2024-03-01T12:34:56Z",
    status: 200,
    latencyMs: 8.5,
  });
  const failureEvent = JSON.stringify({
    service: "worker",
    at: "2024-03-01T12:35:56Z",
    status: 500,
    latencyMs: 22,
  });
  await writeFile(inputPath, `${goodEvent}\r\n \t\r\n{not json}\r\n${failureEvent}\r\n`, "utf8");

  const result = runCli([inputPath], directory);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    "# Relay incident report\n" +
      "\n" +
      "Events: 2 | Failures: 1 | Invalid lines: 1\n" +
      "\n" +
      "| Service | Events | Failures | Error rate | p95 (ms) |\n" +
      "| --- | ---: | ---: | ---: | ---: |\n" +
      "| api | 1 | 0 | 0.0% | 8.5 |\n" +
      "| worker | 1 | 1 | 100.0% | 22.0 |\n" +
      "\n" +
      "## Invalid lines\n" +
      "- Line 3: line is not valid JSON\n",
  );
});

test("requires exactly one input path and prints usage to stderr", async (t) => {
  const directory = await makeTempDir(t);

  for (const args of [[], ["one.jsonl", "two.jsonl"]]) {
    const result = runCli(args, directory);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: relay <input-file>/);
  }
});

test("unreadable paths exit 2 with a useful stderr diagnostic and no report", async (t) => {
  const directory = await makeTempDir(t);
  const missingPath = join(directory, "missing.jsonl");
  const directoryPath = join(directory, "not-a-file");
  await mkdir(directoryPath);

  for (const inputPath of [missingPath, directoryPath]) {
    const result = runCli([inputPath], directory);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot read/);
    assert.ok(result.stderr.includes(inputPath));
  }
});
