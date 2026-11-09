import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
        "--",
      ],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summary,
          PINATA_BENCH_ROOT: join(cwd, "measurement"),
        },
      },
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
    assert.equal(status.retention, "copied");
    const log = await readFile(join(directory, file.replace(".status.json", ".log")), "utf8");
    assert.match(log, /before failure/);
    assert.match(log, /diagnostic/);
  }
  assert.equal((await readFile(summary, "utf8")).match(/Benchmark broken: failed/g).length, 2);
});

test("CI benchmark capture preserves successful exit status", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pinata-ci-evidence-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [wrapper, "success", "-e", "", "--"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "", PINATA_BENCH_ROOT: undefined },
  });
  assert.equal(child.status, 0, child.stderr);
  const results = join(cwd, "bench/results");
  const file = (await readdir(results)).find((entry) => entry.endsWith(".status.json"));
  assert(file);
  const status = JSON.parse(await readFile(join(results, file), "utf8"));
  t.after(() => rm(status.measurementDirectory, { recursive: true, force: true }));
  assert.equal(dirname(status.measurementDirectory), await realpath(tmpdir()));
  assert.equal(status.retention, "copied");
});

test("CI benchmark storage selection retains every failed batch file without rewriting original paths", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pinata-ci-retained-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const fixture = join(cwd, "fixture.mjs");
  await writeFile(
    fixture,
    `
    import { mkdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const output = process.argv[process.argv.indexOf("--out") + 1];
    const cell = join(output + ".cells", "allocated-cell");
    await mkdir(join(cell, "empty"), { recursive: true });
    await writeFile(output, JSON.stringify({ status: "failed", directory: cell }));
    await writeFile(output.replace(/\\.json$/, ".md"), "Failed batch retained.\\n");
    await writeFile(join(cell, ".raw-evidence"), Buffer.from([0, 255, 1, 254]));
    await writeFile(join(cell, "status.json"), JSON.stringify({ state: "interrupted_unknown" }));
    process.exitCode = 7;
  `,
  );
  const selectedRoot = join(cwd, "selected-medium");
  const child = spawnSync(process.execPath, [wrapper, "retained", fixture], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "", PINATA_BENCH_ROOT: selectedRoot },
  });
  assert.equal(child.status, 7, child.stderr);
  const results = join(cwd, "bench/results");
  const entries = await readdir(results);
  const statusName = entries.find((entry) => entry.endsWith(".status.json"));
  const mappingName = entries.find((entry) => entry.endsWith(".paths.json"));
  assert(statusName && mappingName);
  const status = JSON.parse(await readFile(join(results, statusName), "utf8"));
  const mapping = JSON.parse(await readFile(join(results, mappingName), "utf8"));
  assert.equal(dirname(status.measurementDirectory), await realpath(selectedRoot));
  assert.equal(status.code, 7);
  assert.equal(status.retention, "copied");
  assert.equal(mapping.originalDirectory, status.measurementDirectory);
  assert.equal(mapping.retainedDirectory, status.retainedDirectory);
  assert.equal(mapping.sourceRetained, true);
  assert.deepEqual(await readFile(mapping.retainedReport), await readFile(mapping.originalReport));
  assert.equal(
    JSON.parse(await readFile(mapping.retainedReport, "utf8")).directory,
    join(mapping.originalCells, "allocated-cell"),
  );
  for (const root of [mapping.originalCells, mapping.retainedCells]) {
    assert.deepEqual(
      await readFile(join(root, "allocated-cell", ".raw-evidence")),
      Buffer.from([0, 255, 1, 254]),
    );
    assert.equal(
      JSON.parse(await readFile(join(root, "allocated-cell", "status.json"), "utf8")).state,
      "interrupted_unknown",
    );
    assert.deepEqual(await readdir(join(root, "allocated-cell", "empty")), []);
  }
});

test("CI benchmark storage failure is retained without falling back to another filesystem", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pinata-ci-storage-failure-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const selectedRoot = join(cwd, "not-a-directory");
  await writeFile(selectedRoot, "Keep this existing file.");
  const child = spawnSync(process.execPath, [wrapper, "storage", "-e", "process.exit(0)", "--"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "", PINATA_BENCH_ROOT: selectedRoot },
  });
  assert.equal(child.status, 1, child.stderr);
  const results = join(cwd, "bench/results");
  const statusName = (await readdir(results)).find((entry) => entry.endsWith(".status.json"));
  assert(statusName);
  const status = JSON.parse(await readFile(join(results, statusName), "utf8"));
  assert.equal(status.state, "finished");
  assert.equal(status.measurementRoot, selectedRoot);
  assert.equal(status.measurementDirectory, undefined);
  assert.equal(status.retention, "not_allocated");
  assert.match(status.error, /EEXIST|ENOTDIR/);
  assert.equal(await readFile(selectedRoot, "utf8"), "Keep this existing file.");
});

for (const signal of ["SIGINT", "SIGTERM"])
  test(
    `CI benchmark ${signal} forwards interruption and retains the pending batch before exiting`,
    { skip: process.platform === "win32", timeout: 20_000 },
    async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), "pinata-ci-interrupt-"));
      t.after(() => rm(cwd, { recursive: true, force: true }));
      const fixture = join(cwd, "fixture.mjs");
      await writeFile(
        fixture,
        `
      import { mkdir, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      const output = process.argv[process.argv.indexOf("--out") + 1];
      const cell = join(output + ".cells", "pending-cell");
      await mkdir(cell, { recursive: true });
      await writeFile(output, JSON.stringify({ status: "running", directory: cell }));
      await writeFile(join(cell, "status.json"), JSON.stringify({ state: "running" }));
      const watchdog = setTimeout(() => process.exit(9), 10_000);
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, async () => {
          clearTimeout(watchdog);
          await writeFile(join(cell, "interrupted.json"), JSON.stringify({ signal }));
          process.exit(0);
        });
      process.stdout.write("fixture-allocated\\n");
    `,
      );
      const child = spawn(process.execPath, [wrapper, "interrupt", fixture], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: "",
          PINATA_BENCH_ROOT: join(cwd, "measurement"),
        },
      });
      const exited = once(child, "exit");
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
      });
      let output = "";
      let errors = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        errors += chunk;
      });
      const allocated = new Promise((done) => {
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          output += chunk;
          if (output.includes("fixture-allocated")) done();
        });
      });
      await Promise.race([
        allocated,
        exited.then(() => {
          throw new Error(`Wrapper exited before allocation: ${errors}`);
        }),
      ]);
      child.kill(signal);
      const [code, stoppedBy] = await exited;
      assert.equal(code, null, errors);
      assert.equal(stoppedBy, signal, errors);
      const results = join(cwd, "bench/results");
      const names = await readdir(results);
      const statusName = names.find((entry) => entry.endsWith(".status.json"));
      const mappingName = names.find((entry) => entry.endsWith(".paths.json"));
      assert(statusName && mappingName);
      const status = JSON.parse(await readFile(join(results, statusName), "utf8"));
      const mapping = JSON.parse(await readFile(join(results, mappingName), "utf8"));
      assert.equal(status.state, "finished");
      assert.equal(status.code, 0, "The fixture handled the forwarded signal gracefully");
      assert.equal(status.interruptedSignal, signal);
      assert.equal(status.retention, "copied");
      for (const root of [mapping.originalCells, mapping.retainedCells]) {
        assert.equal(
          JSON.parse(await readFile(join(root, "pending-cell", "status.json"), "utf8")).state,
          "running",
        );
        assert.equal(
          JSON.parse(await readFile(join(root, "pending-cell", "interrupted.json"), "utf8")).signal,
          signal,
        );
      }
    },
  );
