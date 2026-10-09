// Live smoke (spends real tokens): the engine inside the real `pi` binary with the user's model
// configuration. The parent model is asked to call pinata_run with 3 parallel scouts and a
// dependent planner; every agent must succeed (PINATA_LIVE_BACKEND picks the backend).
// Requires PINATA_LIVE_SMOKE=1 and
// PINATA_LIVE_CONFIG (an approved pinata config, such as examples/configs/luna.json).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piCommand, rpc } from "./pi-smoke.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function main() {
  assert.ok(
    ["1", "I_AUTHORIZE_PAID_MODEL_CALLS"].includes(process.env.PINATA_LIVE_SMOKE ?? ""),
    "Live spending disabled: set PINATA_LIVE_SMOKE=1 with an approved PINATA_LIVE_CONFIG",
  );
  assert(process.env.PINATA_LIVE_CONFIG, "Supply an approved model config file");
  const config = JSON.parse(await readFile(resolve(process.env.PINATA_LIVE_CONFIG), "utf8"));
  const parent = config.models?.default;
  assert(parent?.provider && parent?.id, "The config needs models.default");
  const dir = await mkdtemp(join(tmpdir(), "pinata-live-engine-"));
  const repo = join(dir, "repo");
  await mkdir(join(repo, ".pi"), { recursive: true });
  await writeFile(join(repo, ".pi", "pinata.json"), JSON.stringify({ models: config.models }));
  await writeFile(
    join(repo, "retry.mjs"),
    "export const retryable = (status) => status === 429 || status >= 500;\nexport const delayFromHeader = (raw) => Number.parseInt(raw, 10) || 1000;\n",
  );
  await writeFile(
    join(repo, "README.md"),
    "# Live fixture\n\nretry.mjs decides which HTTP statuses to retry.\n",
  );
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "init",
    ],
  ])
    assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0);
  const tasks = [
    {
      id: "scout-status",
      role: "scout",
      task: "Which HTTP statuses does retryable() in retry.mjs treat as retryable? Cite file:line.",
      acceptance: ["Exact statuses with file:line"],
    },
    {
      id: "scout-delay",
      role: "scout",
      task: "What does delayFromHeader('0') return in retry.mjs, and why? Cite file:line.",
      acceptance: ["Exact value with file:line"],
    },
    {
      id: "scout-readme",
      role: "scout",
      task: "Summarize README.md in one sentence.",
      acceptance: ["One sentence"],
    },
    {
      id: "plan",
      role: "planner",
      after: ["scout-status", "scout-delay", "scout-readme"],
      task: "From the scouts' findings, list the two smallest fixes that would make retry.mjs treat 0 seconds as a valid delay and stop retrying 600-level statuses. Do not edit files.",
      acceptance: ["Two concrete fixes with file:line"],
    },
  ];
  // Pin every task to the approved file's choice, so global pinata role settings cannot add
  // other models to the smoke (as 0.7.0's quality eval does).
  // PINATA_LIVE_BACKEND=process|herdr-pi runs every agent on that backend (Gate 2).
  const backend = process.env.PINATA_LIVE_BACKEND;
  for (const task of tasks as Array<Record<string, unknown>>) {
    task.model = config.models[task.role as string] ?? config.models.default;
    if (backend) task.backend = backend;
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PI_SKIP_VERSION_CHECK: "1" };
  delete env.PINATA_AGENT;
  delete env.PINATA_LEGACY;
  const pi = rpc(
    [
      ...piCommand(),
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--extension",
      join(ROOT, "engine", "pi", "extension.ts"),
      "--provider",
      parent.provider,
      "--model",
      parent.id,
      "--thinking",
      "low",
    ],
    { cwd: repo, env },
  );
  try {
    const t0 = Date.now();
    pi.send({
      type: "prompt",
      message: `Call the pinata_run tool exactly once, with exactly these parameters, then reply with the word DONE and nothing else:\n${JSON.stringify({ tasks })}`,
    });
    const end = await pi.wait(
      (r) => r.type === "tool_execution_end" && r.toolName === "pinata_run",
      900_000,
    );
    const result = end.result?.details?.result;
    await pi.wait((r) => r.type === "agent_settled", 300_000);
    const stats = pi.send({ type: "get_session_stats" });
    const parentStats = (await pi.wait((r) => r.type === "response" && r.id === stats)).data;
    const summary = {
      ok: result?.status === "succeeded",
      status: result?.status,
      tasks: result?.tasks?.map((t: any) => ({ id: t.id, status: t.status, reason: t.reason })),
      agentsCostUsd: result?.costUsd,
      parentCostUsd: parentStats?.cost,
      totalCostUsd: Math.round(((result?.costUsd ?? 0) + (parentStats?.cost ?? 0)) * 1e6) / 1e6,
      elapsedMs: Date.now() - t0,
      model: `${parent.provider}/${parent.id}`,
      backend: backend ?? "in-process",
    };
    console.log(JSON.stringify(summary));
    if (process.env.PINATA_LIVE_KEEP && result?.dir)
      for (const t of tasks) {
        const saved = JSON.parse(
          await readFile(join(result.dir, "results", `${t.id}.json`), "utf8"),
        );
        console.log(
          JSON.stringify({
            task: t.id,
            usage: saved.usage,
            turns: saved.turns,
            toolCalls: saved.toolCalls,
            model: saved.model,
          }),
        );
      }
    assert.equal(result?.status, "succeeded", JSON.stringify(result, null, 2));
  } finally {
    await pi.close();
    if (!process.env.PINATA_LIVE_KEEP) await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
