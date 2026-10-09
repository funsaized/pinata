// Prototype behind the ENGINE_PLAN.md measurements: in-process subagents inside the real Pi binary.
// Uses pi-ai's faux provider, so it makes no network calls and spends no tokens.
//
// Run from the repository root (Linux shown; any OS with Pi works):
//   BENCH_OUT=/tmp/bench.json BENCH_CWD="$PWD" BENCH_AGENT_DIR="$(mktemp -d)" \
//     sh -c '(echo "{\"id\":\"1\",\"type\":\"prompt\",\"message\":\"/bench\"}"; sleep 60) | pi --mode rpc \
//       --no-session --offline --no-approve --no-extensions --no-skills --no-prompt-templates \
//       --no-context-files --no-themes --extension bench/prototypes/inprocess-bench.ts'
// Use /bench for raw pi-agent-core agents, /bench-sdk for full createAgentSession sessions.
// BENCH_AGENT_DIR should be an empty directory so the user's auth and models are never read.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import * as ai from "@earendil-works/pi-ai";
import * as sdk from "@earendil-works/pi-coding-agent";

const OUT = process.env.BENCH_OUT ?? join(tmpdir(), "pinata-bench.json");
const CWD = process.env.BENCH_CWD ?? process.cwd();
const AGENT_DIR = process.env.BENCH_AGENT_DIR ?? join(tmpdir(), "pinata-bench-agent");

// Linux reports RSS and PSS from /proc; other platforms fall back to process.memoryUsage().
function mem() {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const rollup = readFileSync("/proc/self/smaps_rollup", "utf8");
    const kb = (text: string, key: string) =>
      Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0) / 1024;
    return { rssMB: +kb(status, "VmRSS").toFixed(1), pssMB: +kb(rollup, "Pss").toFixed(1) };
  } catch {
    return { rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1), pssMB: null };
  }
}
function gc() {
  const bun = (globalThis as any).Bun;
  if (bun?.gc) bun.gc(true);
  else (globalThis as any).gc?.();
}
const runtimeName = () =>
  (globalThis as any).Bun ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`;

// Three tool rounds of read + grep + ls, then a final answer.
function scoutStep(context: any) {
  const turns = context.messages.filter((m: any) => m.role === "assistant").length;
  return turns < 3
    ? ai.fauxAssistantMessage(
        [
          ai.fauxToolCall("read", { path: "package.json" }),
          ai.fauxToolCall("grep", { pattern: "export", path: "lib", limit: 50 }),
          ai.fauxToolCall("ls", { path: "." }),
        ],
        { stopReason: "toolUse" },
      )
    : ai.fauxAssistantMessage([ai.fauxText("done")]);
}

function wrap(def: any) {
  return {
    ...def,
    execute: (id: string, p: any, s: any, u: any) => def.execute(id, p, s, u, { cwd: CWD }),
  };
}

async function agentRound(n: number) {
  gc();
  const before = mem();
  const t0 = performance.now();
  const agents = Array.from({ length: n }, (_, i) => {
    const faux = ai.createFauxCore({ provider: `faux${i}` });
    faux.setResponses(Array.from({ length: 4 }, () => scoutStep));
    return new Agent({
      initialState: {
        systemPrompt: "You are a scout. ".repeat(200),
        model: faux.getModel(),
        tools: [
          wrap(sdk.createReadToolDefinition(CWD)),
          wrap(sdk.createGrepToolDefinition(CWD)),
          wrap(sdk.createLsToolDefinition(CWD)),
        ],
      },
      streamFn: faux.streamSimple as any,
    });
  });
  const createMs = performance.now() - t0;
  await Promise.all(agents.map((a) => a.prompt("Map the repository.")));
  const wallMs = performance.now() - t0;
  const ok = agents.filter((a) => (a.state.messages.at(-1) as any)?.stopReason === "stop").length;
  gc();
  const retained = mem();
  return {
    kind: "agent",
    n,
    ok,
    createPerAgentMs: +(createMs / n).toFixed(3),
    wallMs: +wallMs.toFixed(1),
    before,
    retained,
    perAgentMB: +((retained.rssMB - before.rssMB) / n).toFixed(2),
  };
}

async function sessionRound(runtime: any, model: any, n: number) {
  gc();
  const before = mem();
  const t0 = performance.now();
  const sessions = [];
  for (let i = 0; i < n; i++) {
    const { session } = await sdk.createAgentSession({
      cwd: CWD,
      agentDir: AGENT_DIR,
      model,
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader: new sdk.DefaultResourceLoader({
        cwd: CWD,
        agentDir: AGENT_DIR,
        settingsManager: sdk.SettingsManager.inMemory({}),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      }),
      tools: ["read", "grep", "ls"],
      sessionManager: sdk.SessionManager.inMemory(CWD),
      settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false } }),
    });
    await (session as any).resourceLoader?.reload?.();
    sessions.push(session);
  }
  const createMs = performance.now() - t0;
  await Promise.all(sessions.map((s) => s.prompt("Map the repository.")));
  const wallMs = performance.now() - t0;
  const ok = sessions.filter((s) => (s.messages.at(-1) as any)?.stopReason === "stop").length;
  gc();
  const retained = mem();
  for (const s of sessions) s.dispose();
  return {
    kind: "session",
    n,
    ok,
    createPerSessionMs: +(createMs / n).toFixed(2),
    wallMs: +wallMs.toFixed(1),
    before,
    retained,
    perSessionMB: +((retained.rssMB - before.rssMB) / n).toFixed(2),
  };
}

export default function (pi: sdk.ExtensionAPI) {
  pi.registerCommand("bench", {
    description: "In-process pi-agent-core agent benchmark",
    handler: async (_args, ctx) => {
      const results: any[] = [{ runtime: runtimeName(), start: mem() }];
      for (const n of [1, 8, 32, 64]) results.push(await agentRound(n));
      writeFileSync(OUT, JSON.stringify(results, null, 2));
      ctx.shutdown();
    },
  });
  pi.registerCommand("bench-sdk", {
    description: "In-process createAgentSession benchmark",
    handler: async (_args, ctx) => {
      const t0 = performance.now();
      const runtime = await sdk.ModelRuntime.create({
        authPath: join(AGENT_DIR, "auth.json"),
        modelsPath: join(AGENT_DIR, "models.json"),
      });
      const runtimeMs = performance.now() - t0;
      const faux = ai.fauxProvider({ provider: "benchfaux" });
      faux.setResponses(Array.from({ length: 4096 }, () => scoutStep));
      runtime.registerNativeProvider(faux.provider);
      const model = runtime.getModel("benchfaux", "faux-1");
      const results: any[] = [
        { runtime: runtimeName(), modelRuntimeCreateMs: +runtimeMs.toFixed(1), start: mem() },
      ];
      for (const n of [1, 8, 32]) results.push(await sessionRound(runtime, model, n));
      writeFileSync(OUT, JSON.stringify(results, null, 2));
      ctx.shutdown();
    },
  });
}
