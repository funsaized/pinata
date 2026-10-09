// The live quality eval on the engine (port of test/quality/live.mjs, same fixtures, oracle and
// scoring). Spends real tokens: needs PINATA_LIVE_SMOKE=1 and PINATA_LIVE_CONFIG.
// Agents run in process, as they do inside Pi, with the user's model credentials. Seeded
// control builders use a faux provider and make no model calls; their reviewers are live.
//   PINATA_LIVE_SMOKE=1 PINATA_LIVE_CONFIG=examples/configs/luna.json PINATA_EVAL_TRIALS=3 \
//     node test/quality/engine.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ai from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InProcessBackend } from "../../engine/backends/in-process.ts";
import { createEngine } from "../../engine/core/engine.ts";
import type { ModelRef, TaskSpec } from "../../engine/core/types.ts";
import { validateGraph } from "../../engine/core/validate.ts";
import { validateConfig } from "../../engine/pi/config.ts";
import { piPipeline } from "../../engine/pi/pipeline.ts";
import { RuntimeCache } from "../../engine/pi/runtime.ts";
import { prepareRun, verificationStages } from "../../engine/verify/stages.ts";
import {
  brokenParser,
  candidates,
  requirements,
  retry,
  scoreClaims,
  scoutTask,
  visibleTests,
} from "./fixtures.mjs";
import { evaluate } from "./oracle.mjs";
import { qualityGate, summarize } from "./report.mjs";
import { FROZEN_FILES, frozen, score } from "./score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));

assert.ok(
  ["1", "I_AUTHORIZE_PAID_MODEL_CALLS"].includes(process.env.PINATA_LIVE_SMOKE ?? ""),
  "Live spending disabled: set PINATA_LIVE_SMOKE=1 with an approved PINATA_LIVE_CONFIG",
);
assert(process.env.PINATA_LIVE_CONFIG, "Supply an approved model config file");
const cfg = JSON.parse(await readFile(resolve(process.env.PINATA_LIVE_CONFIG), "utf8"));
const trials = Number(process.env.PINATA_EVAL_TRIALS ?? 1);
assert(Number.isInteger(trials) && trials >= 1 && trials <= 10, "PINATA_EVAL_TRIALS must be 1..10");
const modelFor = (role: string): ModelRef => cfg.models[role] ?? cfg.models.default;
const SEED: ModelRef = { provider: "pinata-seed", id: "seed", thinking: "off" };
const base = await mkdtemp(join(tmpdir(), "pinata-quality-engine-"));
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const node = process.execPath;
const check = { id: "parse", argv: [node, "--test", "parse.test.mjs"], timeoutMs: 10_000 };

// The parent model runtime with the user's credentials, plus the seed provider.
const parent = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
});
const registry = new ModelRegistry(parent);
const seed = ai.fauxProvider({ provider: SEED.provider, models: [{ id: SEED.id }] });
const seedStep = (context: any) => {
  const messages = (context.messages ?? []).filter((m: any) => m.role !== "system");
  const text = messages
    .map((m: any) =>
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((c: any) => c.text ?? "").join(" "),
    )
    .join("\n");
  const scenario = JSON.parse(/# Task [a-z0-9-]+ \(builder\)\n\n(\{[^\n]*\})/.exec(text)![1]);
  const files = Object.keys(scenario.write);
  return messages.some((m: any) => m.role === "assistant")
    ? ai.fauxAssistantMessage(
        [
          ai.fauxToolCall("submit_result", {
            status: "succeeded",
            summary: "Seeded candidate",
            changedFiles: files,
            checks: [],
            findings: [],
            blockers: [],
          }),
        ],
        { stopReason: "toolUse" },
      )
    : ai.fauxAssistantMessage(
        files.map((path) => ai.fauxToolCall("write", { path, content: scenario.write[path] })),
        { stopReason: "toolUse" },
      );
};
seed.setResponses(Array.from({ length: 10_000 }, () => seedStep));
registry.registerProvider(seed.provider);
await registry.refresh({ allowNetwork: false });

const cache = new RuntimeCache(agentDir);
const engine = createEngine({
  backends: {
    "in-process": new InProcessBackend({ runtime: () => cache.get(registry), agentDir }),
  },
  pipeline: piPipeline(verificationStages()),
});
const config = validateConfig({
  codemode: cfg.codemode !== false,
  setup: false,
  limits: {
    concurrency: 3,
    taskMs: 180_000,
    jobMs: 600_000,
    maxTurns: 20,
    maxToolCalls: 100,
    repairs: 1,
    ...cfg.limits,
  },
}).config;

console.log(
  JSON.stringify({
    evidence: base,
    trials,
    harness: "engine",
    models: {
      scout: modelFor("scout"),
      builder: modelFor("builder"),
      reviewer: modelFor("reviewer"),
    },
    codemode: config.codemode,
  }),
);

async function repository(): Promise<string> {
  const cwd = join(base, `case-${randomUUID()}`);
  await mkdir(cwd);
  for (const [file, source] of Object.entries({
    "README.md": requirements,
    "retry.mjs": retry,
    "parse.mjs": brokenParser,
    "parse.test.mjs": visibleTests,
  }))
    await writeFile(join(cwd, file), source as string);
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
  ])
    assert.equal(spawnSync("git", ["-C", cwd, ...args]).status, 0);
  return cwd;
}

function reviewTask(id: string, build: string): TaskSpec {
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

const reports: any[] = [];
async function runCase(name: string, tasks: TaskSpec[], seeded = false) {
  const cwd = await repository();
  const started = performance.now();
  const report: any = { name, seededBuilder: seeded, cwd, tasks: [] };
  try {
    const id = randomUUID();
    const valid = validateGraph(tasks, { allowWrites: true });
    const prep = await prepareRun(cwd, id, valid, config);
    const handle = await engine.run(tasks, {
      id,
      cwd,
      dir: join(cwd, ".git", "pinata", id),
      limits: config.limits,
      allowWrites: true,
      data: {
        models: Object.fromEntries(tasks.map((t) => [t.id, t.model!])),
        instructions: [],
        codemode: config.codemode,
        backend: "in-process",
        config,
        prep,
      },
    });
    const view = await handle.done;
    report.run = handle.dir;
    for (const task of tasks) {
      const agent = view.agents[task.id];
      const settled = handle.results().get(task.id);
      report.tasks.push({
        id: task.id,
        role: task.role,
        status: agent.status,
        model: task.model,
        live: !(seeded && task.role === "builder"),
        failureStage: settled?.failureStage ?? null,
        metrics: {
          elapsedMs: (agent.settledAt ?? Date.now()) - (agent.startedAt ?? Date.now()),
          usage: settled?.usage ?? null,
          turns: settled?.turns,
          toolCalls: settled?.toolCalls,
        },
        error: agent.reason ?? null,
        result: settled?.result ?? null,
        ...(task.role === "scout" ? { claims: scoreClaims(settled?.result?.brief) } : {}),
      });
      if (task.role === "builder" && agent.status === "succeeded") {
        const worktree = (settled!.data as any).worktree;
        const tested = spawnSync(node, [join(HERE, "oracle.mjs"), worktree], {
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.equal(tested.status, 0, tested.stderr);
        report.oracle = JSON.parse(tested.stdout);
      }
    }
  } catch (e) {
    report.error = (e as Error).message;
  } finally {
    report.elapsedMs = performance.now() - started;
    reports.push(report);
  }
  console.log(
    JSON.stringify({
      finished: name,
      elapsedMs: Math.round(report.elapsedMs),
      oracle: report.oracle && { passed: report.oracle.passed, total: report.oracle.total },
      tasks: report.tasks.map((t: any) => `${t.id}:${t.status}`),
      error: report.error,
    }),
  );
}

// Fail before spending if a control or the oracle changed and is no longer meaningful.
for (const [name, source] of Object.entries(candidates)) {
  const { parseRetryAfter } = await import(
    `data:text/javascript;base64,${Buffer.from(source as string).toString("base64")}`
  );
  const result = evaluate(parseRetryAfter);
  assert.equal(result.passed === result.total, name === "reference", `Broken control: ${name}`);
}

for (let trial = 1; trial <= trials; trial++) {
  await runCase(`trial-${trial}-pipeline`, [
    ...["scout-a", "scout-b"].map((id) => ({
      id,
      role: "scout" as const,
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
              model: SEED,
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

const summary: ReturnType<typeof summarize> & { quality?: unknown } = summarize(reports);
summary.quality = qualityGate(summary);
const scored = score(reports, (t: any) => t.failureStage === "result");
const out = {
  harness: "engine",
  date: new Date().toISOString().slice(0, 10),
  command:
    "PINATA_LIVE_SMOKE=1 PINATA_LIVE_CONFIG=examples/configs/luna.json PINATA_EVAL_TRIALS=3 node test/quality/engine.ts",
  config: cfg,
  trials,
  frozen: frozen(FROZEN_FILES),
  score: scored,
  costUsd: Math.round(summary.usage.cost * 1e6) / 1e6,
  summary,
  cases: reports.map((r) => ({
    name: r.name,
    elapsedMs: Math.round(r.elapsedMs),
    oracle: r.oracle ? { passed: r.oracle.passed, total: r.oracle.total } : null,
    error: r.error,
    tasks: r.tasks.map((t: any) => ({
      id: t.id,
      role: t.role,
      status: t.status,
      verdict: t.result?.review?.verdict,
      failureStage: t.failureStage,
      claims: t.claims
        ? { correct: t.claims.correct, incorrect: t.claims.incorrect, missing: t.claims.missing }
        : undefined,
      error: t.error,
      usage: t.metrics?.usage,
    })),
  })),
};
const file =
  process.env.PINATA_EVAL_OUT ?? join(ROOT, "bench", "results", `quality-engine-${out.date}.json`);
await mkdir(dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(out, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      complete: true,
      evidence: base,
      file,
      score: scored,
      costUsd: out.costUsd,
      quality: summary.quality,
    },
    null,
    2,
  ),
);
