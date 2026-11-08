import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tempDir } from "../engine/helpers.ts";
import { nodeChild, readObject } from "./fixtures.ts";
import { reconcileUsage } from "./usage-prototype.ts";

test(
  "baseline A3: interruption before runner return leaves a running cell without its created batch",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await tempDir(t, "pinata-readiness-matrix-");
    const output = join(directory, "results");
    await mkdir(output);
    const adapter = join(directory, "adapter.json");
    await writeFile(
      adapter,
      JSON.stringify({
        name: "readiness",
        command: "READINESS_NEVER_EXECUTE",
        model: null,
        timeoutMs: 1000,
      }),
    );
    const config = join(directory, "matrix.json");
    await writeFile(
      config,
      JSON.stringify({
        out: output,
        configs: [adapter],
        tasks: ["checkout"],
        rounds: 1,
        timeoutMs: { checkout: 1000 },
      }),
    );
    const child = await nodeChild(new URL("./matrix-child.ts", import.meta.url), [config]);
    assert.equal(child.signal, "SIGKILL", child.stderr + child.stdout);
    const [matrix] = await readdir(output);
    const schedule = await readObject(join(output, matrix, "schedule.json"));
    const cells = schedule.cells as Array<{ status: string; batch: string | null }>;
    assert.equal(cells[0].status, "running");
    assert.equal(cells[0].batch, null);
    assert.match(
      await readFile(join(output, matrix, "created-before-return/fixture.json"), "utf8"),
      /"providerCalls":0/,
    );
    t.diagnostic(
      JSON.stringify({
        probe: "A3",
        unlinkedCreatedBatch: true,
        providerCalls: 0,
        boundary: "actual matrix around stubbed external runner",
      }),
    );
  },
);

test("per-attempt usage covers mixed log modes, duplicates, malformed totals and interrupted responses", () => {
  const small = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.2 };
  const first = { key: "run/a/1/1", responseComplete: true, usage: small };
  const second = {
    key: "run/b/1/1",
    responseComplete: true,
    usage: { ...small, input: 1000, cost: 10 },
  };
  const started = [first.key, second.key];
  const complete = reconcileUsage(started, [first, second, first]);
  assert.equal(complete.inputTokens, 1016);
  assert.equal(complete.costUsd, 10.2);
  for (const observations of [
    [first],
    [first, { ...second, responseComplete: false }],
    [first, { ...second, usage: { ...small, cost: -1 } }],
    [first, second, { ...second, usage: small }],
    [first, second, { key: "malformed" }],
  ])
    assert.equal(reconcileUsage(started, observations).costUsd, null);
  assert.equal(reconcileUsage(started, [first, second], true).costUsd, null);
  assert.equal(reconcileUsage([...started, "run/a/2/1"], [first, second]).costUsd, null);
});
