import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { command, readJson } from "../lib/core.mjs";
import { init, wait, integrate, cleanup, cancel } from "../lib/pinata.mjs";
// helpers.mjs isolates unit tests from the personal Pi agent directory; a live
// run needs the real one for its models and authentication.
const agentDir = process.env.PI_CODING_AGENT_DIR;
const { repository } = await import("./helpers.mjs");
if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = agentDir;

// Opt-in live end-to-end run: real Pi, Herdr, models, and npm registry access.
// A disposable npm project with a dependency and a bug goes through scout ->
// builder -> reviewer -> integrate, with detected setup and codemode enabled.
// An uncommitted test case must reach the workers and survive integration.
assert.equal(
  process.env.PINATA_LIVE_SMOKE,
  "I_AUTHORIZE_PAID_MODEL_CALLS",
  "Live spending disabled. Read docs/testing.md before opting in.",
);
assert(process.env.PINATA_LIVE_CONFIG, "Supply an approved model config file");
const cfg = await readJson(process.env.PINATA_LIVE_CONFIG);
const repo = await repository("pinata-e2e-");
const run$ = async (argv) => {
  const r = await command(argv, { cwd: repo.cwd, timeoutMs: 300_000 });
  assert.equal(r.code, 0, `${argv.join(" ")}\n${r.stderr}`);
  return r.stdout;
};
await fs.writeFile(path.join(repo.cwd, ".gitignore"), "node_modules/\n");
await fs.mkdir(path.join(repo.cwd, "src"));
await fs.writeFile(
  path.join(repo.cwd, "package.json"),
  JSON.stringify(
    {
      name: "pinata-e2e-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
      dependencies: { ms: "2.1.3" },
    },
    null,
    2,
  ),
);
await fs.writeFile(
  path.join(repo.cwd, "src/duration.mjs"),
  `import ms from "ms";\n\n// Formats a duration given in seconds, e.g. 120 -> "2m".\nexport function formatSeconds(seconds) {\n  return ms(seconds);\n}\n`,
);
await fs.writeFile(
  path.join(repo.cwd, "src/duration.test.mjs"),
  `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { formatSeconds } from "./duration.mjs";\n\ntest("formats seconds", () => {\n  assert.equal(formatSeconds(120), "2m");\n  assert.equal(formatSeconds(7200), "2h");\n});\n`,
);
await run$(["npm", "install", "--package-lock-only", "--no-audit", "--no-fund"]);
await run$(["git", "add", "-A"]);
await run$([
  "git",
  "-c",
  "user.name=f",
  "-c",
  "user.email=f@example.invalid",
  "commit",
  "-qm",
  "fixture",
]);
// The coordinator's checkout has dependencies, as a real project would.
await run$(["npm", "ci", "--no-audit", "--no-fund"]);
// Work in progress the workers must see: an uncommitted extra test case.
await fs.writeFile(
  path.join(repo.cwd, "src/duration.test.mjs"),
  `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { formatSeconds } from "./duration.mjs";\n\ntest("formats seconds", () => {\n  assert.equal(formatSeconds(120), "2m");\n  assert.equal(formatSeconds(7200), "2h");\n  assert.equal(formatSeconds(30), "30s");\n});\n`,
);

const test = { id: "unit", argv: ["npm", "test"], timeoutMs: 120_000 };
let run;
try {
  const created = await init({
    cwd: repo.cwd,
    approval: "Explicit PINATA_LIVE_SMOKE authorization for this disposable end-to-end run",
    allowWrites: true,
    config: {
      ...cfg,
      limits: {
        concurrency: 2,
        taskMs: 900_000,
        jobMs: 2_700_000,
        maxTurns: 40,
        repairs: 1,
        costUsd: 10,
      },
    },
    integratedChecks: [test],
    tasks: [
      {
        id: "scout",
        role: "scout",
        task: "Find why src/duration.test.mjs fails. Identify the function, its dependency, and the minimal fix. Do not edit files.",
        acceptance: ["Names src/duration.mjs formatSeconds and the unit mismatch with ms()"],
      },
      {
        id: "fix",
        role: "builder",
        after: ["scout"],
        task: "Fix formatSeconds in src/duration.mjs so it converts seconds to milliseconds before calling ms(). Keep the change minimal.",
        acceptance: ["npm test passes", "Only src/duration.mjs changes"],
        ownership: ["src/duration.mjs"],
        checks: [test],
      },
      {
        id: "review",
        role: "reviewer",
        after: ["fix"],
        reviewOf: "fix",
        task: "Review the formatSeconds fix against its acceptance criteria.",
        acceptance: ["Approve only if the fix is correct, minimal, and tested"],
      },
    ],
  });
  run = created.run;
  assert.equal(created.setup.source, "detected", JSON.stringify(created.setup));
  assert.deepEqual(created.base.uncommittedFiles, ["src/duration.test.mjs"]);
  let status;
  do status = await wait(run, 300_000);
  while (status.waiting);
  assert(
    status.tasks.every((t) => t.status === "succeeded"),
    JSON.stringify(status, null, 2),
  );
  const fix = await readJson(path.join(run, "tasks/fix/1/outcome.json"));
  assert.equal(fix.setup.code, 0, "detected npm ci did not run in the builder worktree");
  const integrated = await integrate(run);
  assert.equal(integrated.integration.status, "verified", JSON.stringify(integrated));
  assert.match(
    await fs.readFile(path.join(repo.cwd, "src/duration.test.mjs"), "utf8"),
    /formatSeconds\(30\), "30s"/,
    "integration lost the uncommitted test case",
  );
  const tools = {};
  for (const t of status.tasks)
    tools[t.id] = (await readJson(path.join(run, `tasks/${t.id}/1/outcome.json`))).toolCalls;
  console.log(
    JSON.stringify(
      {
        passed: true,
        run,
        setup: created.setup,
        base: created.base,
        spend: integrated.spend,
        toolCalls: tools,
        diff: await run$(["git", "diff", "--", "src/duration.mjs"]),
      },
      null,
      2,
    ),
  );
} finally {
  if (run) {
    await cancel(run);
    console.log(JSON.stringify(await cleanup(run, true)));
  }
  console.log("Retained evidence and fixture repository: " + repo.dir);
}
