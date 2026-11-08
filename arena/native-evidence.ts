// Local evidence analysis. Runtime observations are not OS-isolated attestations.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterRequest } from "./types.ts";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

async function lines(path: string): Promise<RecordValue[]> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return object(JSON.parse(line));
      } catch {
        return { malformed: true };
      }
    });
}

export function coordinatorEvidence(events: RecordValue[]) {
  const seen = new Set<string>();
  const messages: RecordValue[] = [];
  const tools: RecordValue[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let usageKnown = true;
  let costKnown = true;
  for (const event of events) {
    if (event.type === "tool_execution_end")
      tools.push({
        tool: event.toolName,
        durationMs: numeric(event.durationMs),
        error: event.isError === true,
      });
    const message = object(event.message);
    // turn_end/agent_end repeat the same messages; count only message_end.
    if (event.type !== "message_end" || message.role !== "assistant") continue;
    const key = String(
      message.responseId ?? `${message.timestamp}:${JSON.stringify(message.content)}`,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push({
      at: numeric(message.timestamp),
      durationMs: numeric(message.durationMs),
      stopReason: message.stopReason,
    });
    const usage = object(message.usage);
    const input = numeric(usage.input),
      output = numeric(usage.output);
    const read = numeric(usage.cacheRead),
      write = numeric(usage.cacheWrite);
    usageKnown &&= input !== null && output !== null && read !== null && write !== null;
    inputTokens += input ?? 0;
    outputTokens += output ?? 0;
    cacheReadTokens += read ?? 0;
    cacheWriteTokens += write ?? 0;
    const cost = numeric(object(usage.cost).total);
    costKnown &&= cost !== null;
    costUsd += cost ?? 0;
  }
  return {
    messages,
    tools,
    usage: {
      inputTokens:
        messages.length && usageKnown ? inputTokens + cacheReadTokens + cacheWriteTokens : null,
      outputTokens: messages.length && usageKnown ? outputTokens : null,
      cacheReadTokens: messages.length && usageKnown ? cacheReadTokens : null,
      cacheWriteTokens: messages.length && usageKnown ? cacheWriteTokens : null,
      costUsd: messages.length && costKnown ? costUsd : null,
      source:
        "Unique Pi message_end responses; input includes cache reads/writes; costs are provider/runtime estimates, not invoices",
    },
  };
}

export async function collectNativeEvidence(
  request: Pick<AdapterRequest, "cwd" | "evidenceDir" | "model">,
  agent: string,
  truncated = false,
  executionComplete = true,
) {
  const raw = await lines(join(request.evidenceDir, "native.stdout.jsonl"));
  const coordinator = coordinatorEvidence(raw);
  const workers: RecordValue[] = [];
  const settlements = new Map<string, RecordValue>();
  const workerMessages = new Map<string, RecordValue>();
  const store = join(request.cwd, ".git", "pinata");
  const runs = await readdir(store, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const run of runs.filter(
    (entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name),
  )) {
    for (const event of await lines(join(store, run.name, "events.jsonl"))) {
      const key = `${run.name}/${event.agent}/${event.assignment}`;
      if (event.t === "agent_started")
        workers.push({
          key,
          at: event.at,
          backend: event.backend,
          workspace:
            object(event.workspace).kind === "live" ? "shared" : object(event.workspace).kind,
          model: event.model,
        });
      if (event.t === "agent_settled")
        settlements.set(key, { key, at: event.at, status: event.status, usage: event.usage });
      // Engine message usage is incremental. Never add settlement/run totals again.
      if (event.t === "message_end" && event.usage)
        workerMessages.set(`${run.name}/${event.seq}`, event);
    }
  }
  const settings = request.model?.settings ?? {};
  const expected = {
    backend: settings.backend ?? "in-process",
    workspace: settings.workspace ?? "shared",
  };
  const deviations = workers.filter(
    (worker) => worker.backend !== expected.backend || worker.workspace !== expected.workspace,
  );
  const mode =
    agent !== "pinata"
      ? "not-applicable"
      : !workers.length
        ? "unknown"
        : deviations.length
          ? "deviated"
          : "observed-matched";
  const usage = { ...coordinator.usage };
  const workerUsage = [...workerMessages.values()].map((event) => object(event.usage));
  const workerUsageComplete =
    workers.length > 0 && settlements.size === workers.length && workerUsage.length > 0;
  if (agent === "pinata" && workerUsageComplete) {
    for (const item of workerUsage) {
      const parts = [item.input, item.cacheRead, item.cacheWrite].map(numeric);
      usage.inputTokens =
        usage.inputTokens !== null && parts.every((part) => part !== null)
          ? usage.inputTokens + parts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
          : null;
      const cacheRead = numeric(item.cacheRead),
        cacheWrite = numeric(item.cacheWrite);
      usage.cacheReadTokens =
        usage.cacheReadTokens !== null && cacheRead !== null
          ? usage.cacheReadTokens + cacheRead
          : null;
      usage.cacheWriteTokens =
        usage.cacheWriteTokens !== null && cacheWrite !== null
          ? usage.cacheWriteTokens + cacheWrite
          : null;
      const output = numeric(item.output),
        cost = numeric(item.cost);
      usage.outputTokens =
        usage.outputTokens !== null && output !== null ? usage.outputTokens + output : null;
      usage.costUsd = usage.costUsd !== null && cost !== null ? usage.costUsd + cost : null;
    }
    usage.source += "; worker usage from unique run/sequence message_end events";
  }
  // Interrupted responses can incur unreported usage; Codex logs don't establish full child usage.
  const observedUsage = { ...usage };
  const completed = raw.some((event) => event.type === "agent_end");
  if (
    raw.some((event) => event.malformed) ||
    !executionComplete ||
    truncated ||
    !completed ||
    (agent === "pinata" && !workerUsageComplete) ||
    agent === "codex"
  ) {
    usage.inputTokens = null;
    usage.outputTokens = null;
    usage.costUsd = null;
    usage.cacheReadTokens = null;
    usage.cacheWriteTokens = null;
    usage.source += "; aggregate unknown: incomplete stream or worker coverage";
  }
  const result = {
    schemaVersion: 1,
    agent,
    lifecycle: await lines(join(request.evidenceDir, "coordinator-lifecycle.jsonl")),
    timeline: await lines(join(request.evidenceDir, "coordinator-timeline.jsonl")),
    codexParentUsage: raw
      .filter((event) => event.type === "turn.completed")
      .map((event) => event.usage),
    expected,
    mode,
    deviations,
    workers,
    settlements: [...settlements.values()],
    coordinator,
    observedUsage,
    usage,
    limitations: [
      "Worker events are runtime evidence, not tamper-proof supervision; comparison eligibility is unchanged.",
      "Pi response durations include provider/stream time, not pure reasoning CPU; tool durations may overlap.",
      "Historical events lack receipt times; gaps and unfinished responses remain unattributed.",
      "Codex child usage is unknown; never substitute parent-only usage for aggregate usage.",
    ],
  };
  await writeFile(
    join(request.evidenceDir, "native-analysis.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
  return result;
}
