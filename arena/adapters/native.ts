import { assertTime, capDeadline, remaining } from "../deadline.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../process.ts";
import { runProtocol } from "./protocol.ts";
import type { AdapterRequest, AdapterResponse } from "../types.ts";

export type NativeAgent = "codex" | "pi" | "pinata";
const codexSpawnFailure =
  /collab spawn failed|no rollout found for thread|failed to load model context for thread/i;
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function configuredExecutable(args: string[] = []): string | undefined {
  return args[2] === "--executable" ? args[3] : undefined;
}

export function nativeInvocation(agent: NativeAgent, request: AdapterRequest, executable?: string) {
  if (executable !== undefined && !isAbsolute(executable))
    throw new Error("Agent executable must be an absolute path");
  if (request.workflow !== "native") throw new Error("Native adapters require --workflow native");
  if (!request.model) throw new Error("Native adapters require an explicit model");
  const deadlineAt = capDeadline(request.deadlineAt, Date.now() + request.limits.timeoutMs)!;
  assertTime(deadlineAt);
  const remainingMs = remaining(deadlineAt, request.limits.timeoutMs);
  // Advisory reserve for integration, verification and cleanup, scaled for short trials.
  const reserveMs = Math.min(60_000, Math.floor(request.limits.timeoutMs * 0.15));
  const { provider, id, settings } = request.model;
  const thinking = settings.thinking ?? "max";
  const concurrency = settings.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 16)
    throw new Error("concurrency must be an integer between 1 and 16");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinking)))
    throw new Error("Unsupported thinking level");
  const shared = [
    `# Plan and execute using ${agent === "pinata" ? "Piñata orchestration" : agent === "codex" ? "Codex native subagents" : "Pi built-in tools (solo baseline)"}`,
    "Begin with a concise execution plan describing responsibilities and useful checks, then immediately execute it. Evolve the plan as needed; do not stop after planning or wait for more instructions.",
    request.task.prompt,
    "Complete the entire assignment in the current candidate checkout.",
    `Public unit boundaries: ${JSON.stringify(request.task.units)}`,
    "You may inspect, test, review and fix your implementation within the time budget.",
    `Time budget: ${request.limits.timeoutMs}ms. Do not inspect task-specific materials outside the candidate checkout. Framework configuration, runtime dependencies and framework-managed worktrees/evidence may live elsewhere.`,
    `Session deadlineAt: ${deadlineAt}; remaining: ${remainingMs}ms; integration/verification/cleanup reserve: ${reserveMs}ms. Consider this reserve before starting additional work; it does not guarantee completion.`,
    "Do not search for arena reference solutions or hidden oracles. Do not commit changes.",
  ];
  if (agent === "codex") {
    shared.push(
      `Use native subagents for independent work, with at most ${concurrency} concurrent workers.`,
      `Use ${id} with ${thinking} reasoning for yourself and every worker; do not select alternate models or custom roles with different settings.`,
      "Coordinate ownership, wait for every worker, integrate their work and verify the complete result before finishing.",
      "If native subagent spawning fails, stop and report failure. Do not silently continue as a solo agent.",
    );
    return {
      command: executable ?? "codex",
      args: [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--model",
        id,
        "-c",
        `model_provider=${JSON.stringify(provider)}`,
        "-c",
        `model_reasoning_effort=${JSON.stringify(thinking)}`,
        "-c",
        "agents.enabled=true",
        "-c",
        `agents.max_concurrent_threads_per_session=${concurrency}`,
        "-c",
        `agents.default_subagent_model=${JSON.stringify(id)}`,
        "-c",
        `agents.default_subagent_reasoning_effort=${JSON.stringify(thinking)}`,
        "--",
        shared.join("\n\n"),
      ],
    };
  }
  const args = [
    ...(agent === "pinata" ? ["--mode", "rpc"] : ["--print", "--mode", "json"]),
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-mcp",
    "--provider",
    provider,
    "--model",
    id,
    "--thinking",
    String(thinking),
  ];
  if (agent === "pi") {
    shared.push(
      "Work directly using Pi's built-in coding tools. This is the solo baseline; do not start other coding agents.",
    );
  } else {
    args.push(
      "-e",
      join(root, "arena/adapters/coordinator.ts"),
      "--tools",
      "read,bash,edit,write,grep,find,ls,pinata_*",
    );
    const model = { provider, id, thinking };
    shared.push(
      "You are the Pinata coordinator. Delegate useful independent work with pinata_run and use ordinary coding tools to inspect, test, reconcile and finish the candidate.",
      `Choose parallelism appropriate to this assignment; the experimental requested worker count is ${concurrency}. Pinata does not enforce it. Assign responsibilities in task text. Shared checkout is the default; select workspace:worktree only when isolation is useful.`,
      "Use background:true and survive:false for workers. Yield when no actionable work remains; assignment completion messages resume you. Add workers with pinata_run {run,...}; send pinata_steer with as:followUp to continue a worker in its saved context.",
      "Inspect failed checks before changing code: coordinator-authored expectations may themselves be wrong. A failed worker or review never hides its changes. after is ordering, not acceptance. Follow-ups do not replay descendants. Request inputs explicitly when composing isolated workspaces.",
      `The user authorizes implementation, tests, review, follow-ups and local application within ${request.cwd}. The arena supervisor independently enforces its timeout; do not pass deadlines or limits to Pinata.`,
      `Use this config for workers: ${JSON.stringify({ models: { default: model, builder: model, reviewer: model, scout: model }, fallbacks: { builder: [], reviewer: [], scout: [] }, setup: false, backend: "in-process", workspace: "shared", worktreeRoot: join(request.evidenceDir, "worktrees") })}`,
      "Shared edits are already delivered. Inspect/apply selected isolated snapshots with pinata_changes and pinata_integrate when useful. Finish the actual candidate using ordinary tools and run the project checks. Execution completion and candidate correctness are recorded independently.",
    );
  }
  const prompt = shared.join("\n\n");
  return agent === "pinata"
    ? {
        command: executable ?? "pi",
        args,
        prompt,
        input:
          JSON.stringify({
            type: "prompt",
            id: "arena",
            message: "/pinata-arena-execute " + JSON.stringify(prompt),
          }) + "\n",
      }
    : { command: executable ?? "pi", args: [...args, "--", prompt] };
}

export function pinataDelegated(stdout: string): boolean {
  return stdout.split("\n").some((line) => {
    try {
      const event = JSON.parse(line);
      return (
        (event.type === "tool_execution_end" &&
          !event.isError &&
          event.toolName === "pinata_run" &&
          !!event.result?.details?.result?.run) ||
        (event.type === "message_end" && event.message?.customType === "pinata-assignment")
      );
    } catch {
      return false;
    }
  });
}
// Historical detector retained only for old evidence readers.
export function pinataIntegrated(stdout: string): boolean {
  let ran = false;
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (
        event.type === "message_end" &&
        event.message?.customType === "pinata-result" &&
        event.message.details?.status === "succeeded"
      )
        ran = true;
      if (event.type !== "tool_execution_end" || event.isError) continue;
      const result = event.result?.details?.result;
      if (event.toolName === "pinata_run" && result?.status === "succeeded") ran = true;
      if (ran && event.toolName === "pinata_integrate" && result?.status === "verified")
        return true;
    } catch {
      /* CLI output may contain non-JSON diagnostics. */
    }
  }
  return false;
}

export async function executeNative(
  agent: NativeAgent,
  request: AdapterRequest,
  executable?: string,
): Promise<AdapterResponse> {
  request = {
    ...request,
    deadlineAt: capDeadline(request.deadlineAt, Date.now() + request.limits.timeoutMs),
  };
  assertTime(request.deadlineAt);
  const invocation = nativeInvocation(agent, request, executable);
  mkdirSync(request.evidenceDir, { recursive: true });
  const started = performance.now();
  // Start cancellation before the hard trial cutoff, leaving time to reap workers.
  const cleanupMs =
    agent === "pinata"
      ? Math.min(3000, Math.floor(request.limits.timeoutMs * 0.1))
      : Math.min(1500, Math.floor(request.limits.timeoutMs * 0.05));
  const run = async (label: string, command: string, args: string[], timeoutMs: number) =>
    runProcess({
      command,
      args,
      ...(label === "native" &&
        "input" in invocation && { input: invocation.input, inputCompletionId: "arena" }),
      newProcessGroup: false,
      ...(agent === "pinata" && label === "native" && { terminationGraceMs: cleanupMs }),
      ...(agent === "pinata" &&
        label === "native" && {
          env: {
            ...process.env,
            PINATA_ARENA_REQUEST: join(request.evidenceDir, "coordinator-request.json"),
          },
        }),
      failOnStderr: agent === "codex" && label === "native" ? codexSpawnFailure : undefined,
      cwd: request.cwd,
      timeoutMs,
      maxLogBytes: 16 * 1024 * 1024,
      stdoutFile: join(request.evidenceDir, `${label}.stdout.jsonl`),
      stderrFile: join(request.evidenceDir, `${label}.stderr.log`),
    });
  if (agent === "pinata")
    writeFileSync(join(request.evidenceDir, "coordinator-request.json"), JSON.stringify(request), {
      flag: "wx",
      mode: 0o600,
    });
  const version = await run(
    "version",
    invocation.command,
    ["--version"],
    remaining(request.deadlineAt, 10000),
  );
  if (version.code !== 0 || version.error || version.timedOut)
    throw new Error("Agent version check failed; inspect version.stderr.log");
  writeFileSync(
    join(request.evidenceDir, "plan-prompt.txt"),
    ("prompt" in invocation ? invocation.prompt : invocation.args.at(-1)!) + "\n",
  );
  writeFileSync(
    join(request.evidenceDir, "invocation.json"),
    JSON.stringify(invocation, null, 2) + "\n",
  );
  const remainingMs =
    remaining(request.deadlineAt, request.limits.timeoutMs - (performance.now() - started)) -
    cleanupMs;
  if (remainingMs <= 0) throw new Error("No time remaining after version check");
  const result = await run("native", invocation.command, invocation.args, remainingMs);
  const delegationObserved =
    agent === "pinata" && !result.stdoutTruncated && pinataDelegated(result.stdout);
  const delegationFailed = agent === "codex" && codexSpawnFailure.test(result.stderr);
  const completed = result.code === 0 && !result.error && !result.timedOut && !delegationFailed;
  return {
    schemaVersion: 1,
    status: completed ? "completed" : "failed",
    framework: {
      name: agent,
      version:
        agent === "pinata"
          ? `${(JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version} (Pi ${version.stdout.trim() || version.stderr.trim()})`
          : version.stdout.trim() || version.stderr.trim(),
    },
    model: request.model,
    usage: {
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      source: "Unknown; raw framework JSONL retained, including available usage events",
    },
    attempts: null,
    repairs: null,
    events: [
      {
        stage: "native-coordinator",
        status: completed ? "completed" : "failed",
        elapsedMs: result.elapsedMs,
        detail: `exit=${result.code}; timedOut=${result.timedOut}; delegationObserved=${delegationObserved}; delegationFailed=${delegationFailed}; error=${result.error}`,
      },
    ],
    limitations: [
      "Native orchestration is exploratory and not independently verified; external runs remain comparison-ineligible.",
      "Model, delegation, ownership and concurrency compliance require inspection of raw framework evidence.",
      "Native self-review and iterative fixes are allowed; the harness timeout is external and no production repair or concurrency limits are injected.",
      "Pi is a solo baseline; Codex and Piñata are instructed to delegate. Successful execution alone does not establish delegation.",
      "Installed user/provider configuration can affect behavior; complete dependency and configuration provenance is not captured.",
      "Frameworks differ in sandboxing and tools. This wrapper is not an OS security boundary.",
      ...(result.stdoutTruncated || result.stderrTruncated
        ? ["Framework logs exceeded the 16 MiB per-stream cap."]
        : []),
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const agent = process.argv[2];
  if (agent !== "codex" && agent !== "pi" && agent !== "pinata")
    throw new Error("Expected codex, pi or pinata");
  let argv = process.argv.slice(3);
  let executable: string | undefined;
  if (argv[0] === "--executable") {
    executable = argv[1];
    if (!executable || !isAbsolute(executable))
      throw new Error("Expected absolute --executable path");
    argv = argv.slice(2);
  }
  await runProtocol(async (request) => {
    const response = await executeNative(agent, request, executable);
    if (response.status === "failed") process.exitCode = 1;
    return response;
  }, argv);
}
