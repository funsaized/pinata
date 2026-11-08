// Scripted measurements only. Run on a filesystem whose identity is recorded separately.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunHandle } from "../../engine/core/engine.ts";
import { atomicJson } from "../../engine/core/store.ts";
import { ZERO_USAGE, type AgentEvent } from "../../engine/core/types.ts";
import { emptyView, reduce } from "../../engine/core/view.ts";
import { consumedInputs } from "../../engine/backends/conversation.ts";
import { deliver } from "../../engine/pi/delivery.ts";
import { claimLedger } from "./journal-prototype.ts";

const report = resolve(process.argv[2] ?? "bench/results/readiness-2026-11-08/profile.json");
await mkdir(dirname(report), { recursive: true });
const directory = await mkdtemp(join(dirname(report), "profile-fixture-"));
const measurements: Array<Record<string, unknown>> = [];
function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samplesMs: samples,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
}
async function measure(operation: () => Promise<unknown>, count: number) {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  return summary(samples);
}
try {
  let revision = 0;
  measurements.push({
    name: "atomic-json-4KiB",
    ...(await measure(
      () =>
        atomicJson(join(directory, "atomic.json"), {
          revision: revision++,
          text: "x".repeat(4096),
        }),
      50,
    )),
  });
  const owner = await claimLedger(join(directory, "ledger"));
  try {
    measurements.push({
      name: "prototype-followup-ack-including-full-replay",
      ...(await measure(
        () =>
          owner.follow(`r${revision}`, {
            worker: "a",
            messageId: `m${revision++}`,
            text: "x".repeat(200),
          }),
        200,
      )),
    });
  } finally {
    await owner.close();
  }
  for (const [workers, history] of [
    [1, 1],
    [64, 1],
    [1, 128],
    [1, 1024],
  ]) {
    const samples: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      let sequence = 0;
      const event = (body: Record<string, unknown>) =>
        ({ v: 2, seq: sequence++, at: 0, run: "profile", ...body }) as AgentEvent;
      const tasks = Array.from({ length: workers }, (_, i) => ({
        id: `w${i}`,
        role: "scout",
        task: "fixture",
      }));
      let view = reduce(emptyView("profile"), event({ t: "run_started", tasks, mode: "lean" }));
      for (let assignment = 1; assignment <= history; assignment++)
        view = reduce(
          view,
          event({ t: "agent_queued", agent: "w0", assignment, task: tasks[0], dependencies: [] }),
        );
      const start = performance.now();
      for (let i = 0; i < 5000; i++)
        view = reduce(
          view,
          event({ t: "text_delta", agent: "w0", assignment: history, delta: "x" }),
        );
      samples.push(performance.now() - start);
    }
    measurements.push({
      name: "baseline-reducer",
      workers,
      history,
      events: 5000,
      warmupIsFirstSample: true,
      ...summary(samples),
    });
  }
  const run = "11111111-1111-1111-1111-111111111111";
  const events = Array.from({ length: 10_000 }, (_, i) => ({
    v: 2,
    seq: i,
    at: i,
    run,
    agent: "a",
    assignment: 1,
    t: "text_delta",
    delta: "x",
  }));
  const settlement = {
    v: 2,
    seq: events.length,
    at: events.length,
    run,
    agent: "a",
    assignment: 1,
    t: "agent_settled",
    status: "succeeded",
    summary: "done",
    usage: ZERO_USAGE,
    turns: 1,
    toolCalls: 0,
  };
  await writeFile(
    join(directory, "events.jsonl"),
    [...events, settlement].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  await atomicJson(join(directory, "notifications.json"), [`${run}:a:1`]);
  const host = {
    sendMessage: () => {
      throw new Error("Already-delivered fixture sent a duplicate");
    },
  } as unknown as ExtensionAPI;
  const handle = { dir: directory, id: run } as RunHandle;
  measurements.push({
    name: "baseline-delivered-outbox-rescan",
    events: events.length + 1,
    ...(await measure(() => deliver(host, handle), 5)),
  });
  const session = join(directory, "session.jsonl");
  const messages = Array.from({ length: 10_000 }, (_, i) =>
    i % 100 === 0
      ? {
          type: "custom_message",
          id: `entry-${i}`,
          customType: "pinata-input",
          details: { message: `message-${i}` },
        }
      : { type: "message", id: `entry-${i}`, message: { role: "user", content: "fixture" } },
  );
  await writeFile(session, messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
  measurements.push({
    name: "baseline-consumed-input-rescan",
    entries: messages.length,
    ...(await measure(() => consumedInputs(session, () => {}), 5)),
  });
  const metadata = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pi: JSON.parse(
      await readFile(
        new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
        "utf8",
      ),
    ).version,
    modelCalls: 0,
    fixturesOnReportFilesystem: true,
  };
  await writeFile(report, JSON.stringify({ metadata, measurements }, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify(
      {
        report,
        metadata,
        measurements: measurements.map(({ samplesMs: _samples, ...measurement }) => measurement),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
