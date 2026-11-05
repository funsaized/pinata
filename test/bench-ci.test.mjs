import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(new URL("../scripts/bench-ci.mjs", import.meta.url));

test("CI benchmark capture retains repeated failures before benchmark imports", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pinata-ci-evidence-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const summary = join(cwd, "summary.md");
  for (let i = 0; i < 2; i++) {
    const child = spawnSync(
      process.execPath,
      [
        wrapper,
        "broken",
        "-e",
        'console.log("before failure"); console.error("diagnostic"); process.exit(7)',
      ],
      { cwd, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } },
    );
    assert.equal(child.status, 7, child.stderr);
  }
  const directory = join(cwd, "bench/results");
  const files = await readdir(directory);
  assert.equal(files.filter((file) => file.endsWith(".log")).length, 2);
  const statuses = files.filter((file) => file.endsWith(".status.json"));
  assert.equal(statuses.length, 2);
  for (const file of statuses) {
    const status = JSON.parse(await readFile(join(directory, file), "utf8"));
    assert.equal(status.state, "finished");
    assert.equal(status.code, 7);
    assert.equal(status.node, process.version);
    const log = await readFile(join(directory, file.replace(".status.json", ".log")), "utf8");
    assert.match(log, /before failure/);
    assert.match(log, /diagnostic/);
  }
  assert.equal((await readFile(summary, "utf8")).match(/Benchmark broken: failed/g).length, 2);
});

test("CI benchmark capture preserves successful exit status", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pinata-ci-evidence-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [wrapper, "success", "-e", ""], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(child.status, 0, child.stderr);
});
