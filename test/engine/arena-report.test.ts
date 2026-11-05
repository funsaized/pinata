import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { tasks } from "../../arena/corpus/index.ts";
import { loadResults, renderReport } from "../../arena/report.ts";
import { runArena, type RunResult } from "../../arena/runner.ts";

let source: string;
let sourceRoot: string;
before(async () => {
  sourceRoot = mkdtempSync(join(tmpdir(), "arena-report-source-"));
  source = (
    await runArena({
      out: sourceRoot,
      batchId: "report-fixture",
      tasks: [tasks[0]!],
      workflows: ["sequential"],
      trials: 2,
      timeoutMs: 10_000,
    })
  ).directory;
});
after(() => rmSync(sourceRoot, { recursive: true, force: true }));

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "arena-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const batch = join(root, "batch");
  const runs = join(batch, "runs");
  mkdirSync(runs, { recursive: true });
  const manifest = join(batch, "manifest.json");
  copyFileSync(join(source, "manifest.json"), manifest);
  const results = readdirSync(join(source, "runs"))
    .sort()
    .map((id) => {
      const dir = join(runs, id);
      mkdirSync(dir);
      const path = join(dir, "result.json");
      copyFileSync(join(source, "runs", id, "result.json"), path);
      return path;
    });
  return { root, batch, runs, manifest, results };
}

function edit(path: string, mutate: (value: any) => void) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  writeFileSync(path, JSON.stringify(value));
}

test("arena reports load manifest order and retain pending, running and failed cells", (t) => {
  for (const status of ["pending", "running", "failed"] as const) {
    const { batch, results } = fixture(t);
    edit(results[1]!, (result: RunResult) => {
      result.status = status;
      result.response = null;
      result.oracle = null;
      result.candidateCorrect = null;
      result.elapsedMs = null;
      result.adapterProcess = null;
      result.treatment = { status: "unverified", reasons: ["No stage evidence available"] };
      result.errors = status === "failed" ? ["Fixture setup failed"] : [];
    });
    const loaded = loadResults([batch]);
    assert.deepEqual(
      loaded.map((result) => [result.trial, result.order]),
      [
        [1, 1],
        [2, 2],
      ],
    );
    assert.equal(loaded[1]!.status, status);
    const report = renderReport(loaded);
    assert.match(report, /2 requested trial cells recorded/);
    assert.match(report, /\| 1\/2 \| 1\/2 \| 1\/2 \|/);
    assert.match(
      report,
      new RegExp(`\\| ${status} \\| unknown \\| unverified \\| yes \\| unknown \\| unknown`),
    );
  }
});

test("arena reports reject missing result, trial directory, runs directory and manifest", (t) => {
  for (const target of ["result", "trial", "runs", "manifest"] as const) {
    const { batch, runs, manifest, results } = fixture(t);
    const path = { result: results[1]!, trial: dirname(results[1]!), runs, manifest }[target];
    rmSync(path, { recursive: true });
    assert.throws(() => loadResults([batch]), /Incomplete batch: missing/);
  }
});

test("arena reports reject repeated paths, normalized aliases and copied batch identities", (t) => {
  const { root, batch } = fixture(t);
  const copied = join(root, "copy");
  cpSync(batch, copied, { recursive: true });
  for (const duplicate of [batch, join(batch, "..", "batch"), copied]) {
    assert.throws(() => loadResults([batch, duplicate]), /Duplicate batch (directory|identity)/);
  }
  const parentAlias = join(root, "alias");
  symlinkSync(root, parentAlias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => loadResults([batch, join(parentAlias, "batch")]),
    /Duplicate batch directory/,
  );
});

test("arena reports require explicit batch dirs and reject overlapping root selections", (t) => {
  const { root, batch, results } = fixture(t);
  assert.throws(() => loadResults([]), /batch directory is required/);
  assert.throws(() => loadResults([root, batch]), /Incomplete batch: missing.*manifest.json/);
  assert.throws(() => loadResults([results[0]!]), /Expected a regular directory/);
});

test("arena reports reject symlinked batch, manifest, runs, trial and result artifacts", async (t) => {
  for (const target of ["batch", "manifest", "runs", "trial", "result"] as const) {
    await t.test(target, (t) => {
      const { root, batch, runs, manifest, results } = fixture(t);
      const path = { batch, manifest, runs, trial: dirname(results[0]!), result: results[0]! }[
        target
      ];
      const copy = join(root, "original");
      cpSync(path, copy, { recursive: true });
      rmSync(path, { recursive: true });
      const file = target === "result" || target === "manifest";
      try {
        symlinkSync(copy, path, file ? "file" : process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (
          file &&
          process.platform === "win32" &&
          (error as NodeJS.ErrnoException).code === "EPERM"
        ) {
          t.skip("Windows file-symlink privilege unavailable");
          return;
        }
        throw error;
      }
      assert.throws(() => loadResults([batch]), /not a symlink/);
    });
  }
});

test("arena reports reject unexpected copied trial cells", (t) => {
  const { batch, runs, results } = fixture(t);
  cpSync(dirname(results[0]!), join(runs, "copied-trial"), { recursive: true });
  assert.throws(() => loadResults([batch]), /Unexpected trial artifact.*copied-trial/);
});

test("arena reports reconcile every result identity and configuration with its manifest", (t) => {
  const mutations: Array<(result: RunResult) => void> = [
    (result) => {
      result.batchId = "other-batch";
    },
    (result) => {
      result.runId = "other-run";
    },
    (result) => {
      result.trial = 3;
    },
    (result) => {
      result.order = 3;
    },
    (result) => {
      result.task.id = "other-task";
    },
    (result) => {
      result.task.version = 2;
    },
    (result) => {
      result.workflow = "parallel";
    },
    (result) => {
      result.mode = "external";
      result.control = null;
    },
    (result) => {
      result.control = null;
    },
    (result) => {
      result.adapter.name = "other-adapter";
    },
    (result) => {
      result.provenance.limits.maxRepairs += 1;
    },
  ];
  for (const mutation of mutations) {
    const { batch, results } = fixture(t);
    edit(results[0]!, mutation);
    assert.throws(() => loadResults([batch]), /does not match batch manifest/);
  }
});

test("arena reports reject copied results under a different planned trial directory", (t) => {
  const { batch, results } = fixture(t);
  copyFileSync(results[0]!, results[1]!);
  assert.throws(() => loadResults([batch]), /does not match batch manifest/);
});

test("arena reports reject malformed manifests and duplicate planned task/workflow identities", (t) => {
  const mutations: Array<(manifest: any) => void> = [
    (manifest) => {
      manifest.schemaVersion = 2;
    },
    (manifest) => {
      manifest.batchId = "../escape";
    },
    (manifest) => {
      manifest.mode = "invented";
    },
    (manifest) => {
      manifest.trials = 0;
    },
    (manifest) => {
      manifest.trials = 1.5;
    },
    (manifest) => {
      manifest.trials = 101;
    },
    (manifest) => {
      manifest.workflows = [];
    },
    (manifest) => {
      manifest.workflows.push(manifest.workflows[0]);
    },
    (manifest) => {
      manifest.workflows = ["invented"];
    },
    (manifest) => {
      manifest.tasks = [];
    },
    (manifest) => {
      manifest.tasks.push(manifest.tasks[0]);
    },
    (manifest) => {
      manifest.tasks[0].id = "../escape";
    },
    (manifest) => {
      manifest.tasks[0].version = null;
    },
    (manifest) => {
      manifest.adapter = null;
    },
    (manifest) => {
      manifest.limits.timeoutMs = -1;
    },
  ];
  for (const mutation of mutations) {
    const { batch, manifest } = fixture(t);
    edit(manifest, mutation);
    assert.throws(() => loadResults([batch]), /Unsupported batch manifest/);
  }
});

test("arena reports reject malformed result JSON and invalid identity types", (t) => {
  const mutations: Array<(result: any) => void> = [
    (result) => {
      result.schemaVersion = 2;
    },
    (result) => {
      result.task = null;
    },
    (result) => {
      result.trial = "1";
    },
    (result) => {
      result.order = 0;
    },
    (result) => {
      result.status = "invented";
    },
    (result) => {
      result.errors = null;
    },
    (result) => {
      result.response.usage.inputTokens = "unknown";
    },
  ];
  for (const mutation of mutations) {
    const { batch, results } = fixture(t);
    edit(results[0]!, mutation);
    assert.throws(() => loadResults([batch]), /Unsupported result artifact/);
  }
  const { batch, manifest, results } = fixture(t);
  writeFileSync(results[0]!, "{");
  assert.throws(() => loadResults([batch]), /Malformed JSON artifact/);
  writeFileSync(manifest, "null");
  assert.throws(() => loadResults([batch]), /Unsupported batch manifest/);
});

test("arena reports reject mixed controls and config identities within one batch", (t) => {
  for (const mutate of [
    (result: RunResult) => {
      result.control = "broken";
    },
    (result: RunResult) => {
      result.provenance.configSha256 = "other-config";
    },
  ]) {
    const { batch, results } = fixture(t);
    edit(results[1]!, mutate);
    assert.throws(() => loadResults([batch]), /Conflicting control configuration/);
  }
});

test("arena reports can combine distinct complete batches without pooling denominators", (t) => {
  const first = fixture(t);
  const second = fixture(t);
  edit(second.manifest, (manifest) => {
    manifest.batchId = "other-batch";
  });
  for (const path of second.results)
    edit(path, (result) => {
      result.batchId = "other-batch";
    });
  const loaded = loadResults([first.batch, second.batch]);
  assert.equal(loaded.length, 4);
  const report = renderReport(loaded);
  assert.match(report, /4 requested trial cells recorded/);
  assert.equal((report.match(/\| 2\/2 \| 2\/2 \| 2\/2 \|/g) ?? []).length, 2);
});

test("arena direct rendering rejects duplicate run, logical cell and order identities", (t) => {
  const { batch } = fixture(t);
  const [first, second] = loadResults([batch]);
  assert.ok(first && second);
  assert.throws(() => renderReport([first, first]), /Duplicate trial identity/);
  assert.throws(
    () => renderReport([first, { ...first, runId: "renamed-run", order: 3 }]),
    /Duplicate requested trial cell/,
  );
  assert.throws(
    () => renderReport([first, { ...second, order: first.order }]),
    /Duplicate trial order/,
  );
});

test("arena report CLI exits nonzero without a partial report for an incomplete batch", (t) => {
  const { batch, results } = fixture(t);
  rmSync(results[1]!);
  const output = spawnSync(process.execPath, [resolve("arena/report.ts"), batch], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(output.status, 1);
  assert.equal(output.stdout, "");
  assert.match(output.stderr, /Incomplete batch: missing.*result.json/);
});
