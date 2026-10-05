import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ROOT, ROLES, command, readJson, shellQuote, validateModel } from "../../lib/core.mjs";
import { executable } from "../../lib/config.mjs";
import { init, wait, cancel, cleanup } from "../../lib/pinata.mjs";
import {
  requirements,
  retry,
  brokenParser,
  visibleTests,
  candidates,
  scoutTask,
  scoreClaims,
} from "./fixtures.mjs";
import { evaluate } from "./oracle.mjs";

// This suite is deliberately excluded from npm test and the published package.
assert.equal(
  process.env.PINATA_LIVE_SMOKE,
  "I_AUTHORIZE_PAID_MODEL_CALLS",
  "Live spending disabled; read docs/testing.md before opting in",
);
assert(process.env.PINATA_LIVE_CONFIG, "Supply an explicit approved model/endpoint config file");
const cfg = await readJson(process.env.PINATA_LIVE_CONFIG);
validateModel(cfg.models?.default);
const trials = Number(process.env.PINATA_EVAL_TRIALS ?? 1);
assert(Number.isInteger(trials) && trials >= 1 && trials <= 10, "PINATA_EVAL_TRIALS must be 1..10");
// Pin each task to the approved file's exact choice. Global pinata role settings
// cannot silently add other models or fallbacks to a controlled experiment.
const modelFor = (role) => validateModel(cfg.models[role] ?? cfg.models.default);
const base = await fs.mkdtemp(path.join(os.tmpdir(), "pinata-quality-"));
const oracle = fileURLToPath(new URL("./oracle.mjs", import.meta.url));
const actualPi = await executable(cfg.pi ?? "pi");
const wrapper = path.join(base, "seed-pi");
await fs.writeFile(
  wrapper,
  `#!/bin/bash\nlast=""\nfor arg in "$@"; do last="$arg"; done\nif [ "$last" = /builder ]; then exec ${shellQuote(process.execPath)} ${shellQuote(path.join(ROOT, "test/fixtures/pi.mjs"))} "$@"; fi\nexec ${shellQuote(actualPi)} "$@"\n`,
  { mode: 0o700 },
);
const check = {
  id: "parse",
  argv: [process.execPath, "--test", "parse.test.mjs"],
  timeoutMs: 10_000,
};
const reports = [];
let saving = Promise.resolve();
const saveReports = (summary) => {
  const json = JSON.stringify({ trials, reports, summary }, null, 2) + "\n";
  saving = saving.then(async () => {
    const temporary = path.join(base, `results-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, json, { mode: 0o600 });
    await fs.rename(temporary, path.join(base, "results.json"));
  });
  return saving;
};
console.log(
  JSON.stringify({
    evidence: base,
    trials,
    models: Object.fromEntries(["scout", "builder", "reviewer"].map((r) => [r, modelFor(r)])),
    codemode: cfg.codemode !== false,
  }),
);

async function repository() {
  // Keep expected verdict labels out of paths visible to the workers.
  const cwd = path.join(base, `case-${randomUUID()}`);
  await fs.mkdir(cwd);
  for (const [file, source] of Object.entries({
    "README.md": requirements,
    "retry.mjs": retry,
    "parse.mjs": brokenParser,
    "parse.test.mjs": visibleTests,
  }))
    await fs.writeFile(path.join(cwd, file), source);
  for (const args of [
    ["init", "-q"],
    ["add", "--", "README.md", "retry.mjs", "parse.mjs", "parse.test.mjs"],
    [
      "-c",
      "user.name=pinata evaluation",
      "-c",
      "user.email=evaluation@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Evaluation baseline",
    ],
  ]) {
    const result = await command(["git", "-C", cwd, ...args]);
    assert.equal(result.code, 0, result.stderr);
  }
  return cwd;
}

function reviewTask(id, build) {
  return {
    id,
    role: "reviewer",
    model: modelFor("reviewer"),
    after: [build],
    reviewOf: build,
    task: "Independently review the parser implementation against every README.md requirement and the builder acceptance criteria. Inspect source, diff, tests and supervisor evidence. Passing visible tests alone is insufficient. Identify concrete failures with exact inputs and file:line evidence, or approve if correct.",
    acceptance: [
      "Approve only if every parser requirement holds; report concrete failure scenarios.",
    ],
  };
}

async function runCase(name, tasks, seeded = false) {
  const cwd = await repository();
  const started = performance.now();
  let run;
  const report = { name, seededBuilder: seeded, cwd, tasks: [] };
  try {
    run = (
      await init({
        cwd,
        approval:
          "Explicit opt-in spending authorization for bounded live quality trials in disposable fixtures",
        allowWrites: true,
        noIntegratedChecksReason: "Quality evaluation only; candidates are never integrated",
        config: {
          ...cfg,
          pi: seeded ? wrapper : actualPi,
          codemode: cfg.codemode !== false,
          setup: false,
          fallbacks: Object.fromEntries(ROLES.map((r) => [r, []])),
          limits: {
            ...cfg.limits,
            concurrency: 3,
            startupMs: 30_000,
            taskMs: 180_000,
            jobMs: 600_000,
            maxTurns: 20,
            maxToolCalls: 100,
            repairs: 1,
          },
        },
        tasks,
      })
    ).run;
    report.run = run;
    let state;
    do {
      state = await wait(run, 20_000);
      console.log(
        JSON.stringify({
          case: name,
          tasks: state.tasks.map(({ id, status }) => ({ id, status })),
        }),
      );
    } while (state.waiting);
    const manifest = await readJson(path.join(run, "manifest.json"));
    for (const task of manifest.tasks) {
      const attempt = task.attempts.at(-1);
      const out =
        attempt &&
        (await readJson(
          path.join(run, "tasks", task.spec.id, String(attempt.number), "outcome.json"),
        ).catch(() => null));
      report.tasks.push({
        id: task.spec.id,
        role: task.spec.role,
        status: task.status,
        model: attempt?.model,
        modelOrigin: attempt?.modelOrigin,
        live: !(seeded && task.spec.role === "builder"),
        metrics: out?.metrics,
        error: out?.error ?? task.error,
        result: out?.result,
        ...(task.spec.role === "scout" ? { claims: scoreClaims(out?.result?.brief) } : {}),
      });
      if (task.spec.role === "builder" && task.status === "succeeded") {
        // Oracle code and expected values stay outside every worker checkout.
        // Import candidates in a separate supervised process, with a deadline.
        const tested = await command([process.execPath, oracle, task.worktree], {
          timeoutMs: 10_000,
          maxBytes: 1024 * 1024,
        });
        assert.equal(tested.code, 0, tested.stderr);
        report.oracle = JSON.parse(tested.stdout);
      }
    }
    report.versions = manifest.versions;
  } catch (e) {
    report.error = e.message;
  } finally {
    report.elapsedMs = performance.now() - started;
    reports.push(report);
    await saveReports(summarize(reports));
    if (run) {
      await cancel(run);
      await cleanup(run, true); // keeps dirty unintegrated candidates and all evidence
    }
  }
  console.log(
    JSON.stringify({
      finished: name,
      run,
      elapsedMs: report.elapsedMs,
      oracle: report.oracle,
      error: report.error,
    }),
  );
}

function summarize(rows) {
  const controls = rows.filter((r) => r.seededBuilder);
  const reviews = controls.map((r) => ({
    expected: r.name.includes("-reference") ? "approve" : "changes_requested",
    actual: r.tasks.find((t) => t.role === "reviewer")?.result?.review?.verdict,
  }));
  const scouts = rows.flatMap((r) => r.tasks.filter((t) => t.role === "scout"));
  const live = rows.flatMap((r) => r.tasks.filter((t) => t.live));
  const numeric = live
    .map((t) => t.metrics?.elapsedMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    completedCases: rows.length,
    infrastructureErrors: rows.filter((r) => r.error).length,
    builderOracle: rows
      .filter((r) => !r.seededBuilder)
      .map((r) => ({ case: r.name, passed: r.oracle?.passed, total: r.oracle?.total })),
    reviewControls: {
      total: reviews.length,
      evaluated: reviews.filter((r) => r.actual).length,
      falseApprovals: reviews.filter(
        (r) => r.expected === "changes_requested" && r.actual === "approve",
      ).length,
      falseRejections: reviews.filter(
        (r) => r.expected === "approve" && r.actual === "changes_requested",
      ).length,
      missingVerdicts: reviews.filter((r) => !r.actual).length,
    },
    factualClaims: {
      total: scouts.reduce((n, t) => n + t.claims.total, 0),
      correct: scouts.reduce((n, t) => n + t.claims.correct, 0),
      incorrect: scouts.reduce((n, t) => n + t.claims.incorrect, 0),
      missing: scouts.reduce((n, t) => n + t.claims.missing, 0),
      supported: scouts.reduce((n, t) => n + t.claims.supported, 0),
      noncanonical: scouts.reduce((n, t) => n + t.claims.noncanonical, 0),
    },
    liveTasks: live.length,
    missingUsage: live.filter((t) => !t.metrics?.usage).length,
    latencyMs: numeric.length
      ? { min: numeric[0], median: numeric[Math.floor(numeric.length / 2)], max: numeric.at(-1) }
      : null,
    usage: live.reduce(
      (sum, t) => {
        for (const key of Object.keys(sum)) sum[key] += t.metrics?.usage?.[key] ?? 0;
        return sum;
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    ),
    limitation:
      "Small controlled fixture, not a global model benchmark. Seeded builders are deterministic; their reviewers are live. Missing verdicts and usage are reported separately. No quality threshold is used to hide failed trials.",
  };
}

// Fail before spending if a control/oracle changed and is no longer meaningful.
for (const [name, source] of Object.entries(candidates)) {
  const { parseRetryAfter } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const oracleResult = evaluate(parseRetryAfter);
  assert.equal(
    oracleResult.passed === oracleResult.total,
    name === "reference",
    `Broken control: ${name}`,
  );
}
for (let trial = 1; trial <= trials; trial++) {
  await runCase(`trial-${trial}-pipeline`, [
    ...["scout-a", "scout-b"].map((id) => ({
      id,
      role: "scout",
      model: modelFor("scout"),
      task: scoutTask,
      acceptance: [
        "Identify real defects with concrete evidence and report all seven exact factual answers.",
      ],
    })),
    {
      id: "build",
      role: "builder",
      model: modelFor("builder"),
      task: "Fix parseRetryAfter in parse.mjs to satisfy every README.md requirement. Add focused regression tests in parse.test.mjs. Change only these two files.",
      acceptance: [
        "Every parser requirement holds, including invalid calendar dates, early years, zero and unsafe values.",
        "Existing and regression tests pass.",
      ],
      ownership: ["parse.mjs", "parse.test.mjs"],
      checks: [check],
    },
    reviewTask("review", "build"),
  ]);
  // Independent repositories let each candidate own the same paths without
  // overlapping builders. At most three live control reviewers run at once.
  const controls = Object.entries(candidates);
  for (let offset = 0; offset < controls.length; offset += 3)
    await Promise.all(
      controls.slice(offset, offset + 3).map(([name, source]) =>
        runCase(
          `trial-${trial}-${name}`,
          [
            {
              id: "build",
              role: "builder",
              model: modelFor("builder"),
              task: JSON.stringify({ write: { "parse.mjs": source } }),
              acceptance: [
                "Implement every parser requirement in README.md.",
                "Existing tests pass.",
              ],
              ownership: ["parse.mjs"],
              checks: [check],
            },
            reviewTask("review", "build"),
          ],
          true,
        ),
      ),
    );
}
const final = summarize(reports);
await saveReports(final);
console.log(JSON.stringify({ complete: true, evidence: base, summary: final }, null, 2));
if (
  reports.some(
    (r) => r.error || r.tasks.some((t) => t.live && !["succeeded", "rejected"].includes(t.status)),
  )
)
  process.exitCode = 1;
