import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { qualityGate, summarize } from "../quality/report.mjs";
import { score } from "../quality/score.mjs";
import { candidates, scoreClaims } from "../quality/fixtures.mjs";
import { evaluate } from "../quality/oracle.mjs";
import { tempDir } from "./helpers.ts";

function passingRows(): any[] {
  const task = (role: string, extra = {}) => ({
    role,
    live: true,
    status: "succeeded",
    metrics: { usage: { cost: 0.01 } },
    ...extra,
  });
  const scout = () =>
    task("scout", {
      claims: { total: 7, correct: 7, incorrect: 0, missing: 0, supported: 7, noncanonical: 0 },
    });
  return [
    {
      name: "trial-1-pipeline",
      seededBuilder: false,
      oracle: { passed: 29, total: 29 },
      tasks: [
        scout(),
        scout(),
        task("builder"),
        task("reviewer", { result: { review: { verdict: "approve" } } }),
      ],
    },
    ...Object.keys(candidates).map((name) => ({
      name: `trial-1-${name}`,
      seededBuilder: true,
      tasks: [
        task("builder", { live: false }),
        task("reviewer", {
          result: { review: { verdict: name === "reference" ? "approve" : "changes_requested" } },
        }),
      ],
    })),
  ];
}

test("quality passes correct work and rejects wrong, missing and unsupported evidence", () => {
  assert.equal(qualityGate(summarize(passingRows())).passed, true);
  const changes = [
    (rows: any[]) => {
      rows[0].oracle.passed = 28;
    },
    (rows: any[]) => {
      delete rows[0].oracle;
    },
    (rows: any[]) => {
      rows[1].tasks[1].result.review.verdict = "changes_requested";
    },
    (rows: any[]) => {
      rows[2].tasks[1].result.review.verdict = "approve";
    },
    (rows: any[]) => {
      delete rows[2].tasks[1].result.review;
    },
    (rows: any[]) => {
      rows[0].tasks[0].status = "failed";
    },
    (rows: any[]) => {
      rows[0].tasks[0].claims = scoreClaims("");
    },
    (rows: any[]) => {
      rows[0].tasks[0].claims.supported = 6;
    },
    (rows: any[]) => {
      rows[0].error = "run failed before all results were collected";
    },
  ];
  for (const change of changes) {
    const rows = passingRows();
    change(rows);
    const quality = qualityGate(summarize(rows));
    assert.equal(quality.passed, false);
    assert(quality.failures.length);
  }
  assert.equal(qualityGate(summarize([])).passed, false);
});

test("quality scoring and controls retain failure opportunities", async () => {
  const rows = passingRows();
  assert.equal(score(rows, () => false).composite, 1);
  rows[0].oracle = undefined;
  rows[0].tasks[0].claims = scoreClaims("");
  rows[2].tasks[1].result = undefined;
  const scored = score(rows, (t: any) => !t.result && t.role === "reviewer");
  assert.equal(scored.builderPassRate, 0);
  assert.equal(scored.factualAccuracy, 0.5);
  assert.equal(scored.reviewAccuracy, 0.75);
  assert.equal(scored.resultFormatFailures, 1);
  for (const [name, source] of Object.entries(candidates)) {
    const { parseRetryAfter } = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    const outcome = evaluate(parseRetryAfter);
    assert.equal(outcome.total, 29);
    assert.equal(outcome.passed === outcome.total, name === "reference");
  }
});

test("quality report is saved before a failed gate exits nonzero", async (t) => {
  const dir = await tempDir(t, "pinata-quality-gate-");
  const module = new URL("../quality/report.mjs", import.meta.url).href;
  for (const passing of [true, false]) {
    const rows = passingRows();
    if (!passing) rows[0].oracle.passed = 28;
    const input = join(dir, "input.json");
    const output = join(dir, "reports", `${passing}.json`);
    await writeFile(input, JSON.stringify({ summary: summarize(rows), cases: rows }));
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { readFile } from "node:fs/promises";
      import { writeQualityReport } from ${JSON.stringify(module)};
      const report = JSON.parse(await readFile(process.argv[1], "utf8"));
      process.exitCode = await writeQualityReport(process.argv[2], report);
    `,
        input,
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, passing ? 0 : 1, child.stderr);
    const saved = JSON.parse(await readFile(output, "utf8"));
    assert.equal(saved.summary.quality.passed, passing);
    assert.equal(saved.cases[0].oracle.passed, passing ? 29 : 28);
  }
});
