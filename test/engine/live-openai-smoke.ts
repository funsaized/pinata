// Paid integration smoke. Ordinary npm test never invokes this entry point.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { openHost } from "../../engine/host/index.ts";
import { processArtifacts } from "../../engine/backends/process-transport.ts";
import { liveLimits, liveModel, liveReportSchema } from "./fixtures/live-openai-agent.ts";

if (!process.env.OPENAI_API_KEY)
  throw new Error("OPENAI_API_KEY is required for the paid live check");
const output = process.env.PINATA_LIVE_OUTPUT
  ? resolve(process.env.PINATA_LIVE_OUTPUT)
  : await mkdtemp(join(tmpdir(), "pinata-live-openai-"));
await mkdir(output, { recursive: true });
const requests = join(output, "requests");
await mkdir(requests);
process.env.PINATA_LIVE_REQUESTS = requests;
// Pi credentials and personal settings never enter the uploaded evidence directory.
const privateAgent = await mkdtemp(join(tmpdir(), "pinata-live-agent-"));
const bootstrapModule = fileURLToPath(new URL("./fixtures/live-openai-agent.ts", import.meta.url));
const reports: unknown[] = [];
const observedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const errors: string[] = [];
let ok = false;

function toolNames(entries: unknown[]): string[] {
  const entrySchema = z.looseObject({
    message: z.looseObject({ role: z.literal("assistant"), content: z.array(z.unknown()) }),
  });
  const callSchema = z.looseObject({ type: z.literal("toolCall"), name: z.string() });
  return entries.flatMap((entry) => {
    const parsed = entrySchema.safeParse(entry);
    if (!parsed.success) return [];
    return parsed.data.message.content.flatMap((content) => {
      const call = callSchema.safeParse(content);
      return call.success ? [call.data.name] : [];
    });
  });
}

try {
  for (const backend of ["in-process", "process"] as const) {
    const directory = join(output, backend);
    const workspace = join(directory, "workspace");
    const agentDir = join(privateAgent, backend);
    const definitions = join(directory, "definitions");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(agentDir),
      mkdir(definitions, { recursive: true }),
    ]);
    const first = randomUUID();
    await writeFile(join(workspace, "challenge.txt"), first + "\n");
    const host = await openHost({
      directory: join(directory, "run"),
      workspace,
      agentDir,
      definitionDirectories: [definitions],
      bootstrapModule,
      parentModel: { provider: "openai", id: liveModel, thinking: "off" },
      config: { run: { backend, codemode: false, setup: false } },
    });
    try {
      const created = await host.runtime.execute(
        {
          requestId: "live-create",
          command: {
            kind: "create",
            workers: [
              {
                id: "worker",
                agent: "live-check",
                task: "Read challenge.txt, write result.txt and submit the initial report.",
              },
            ],
          },
        },
        host.caller,
      );
      assert.equal(created.status, "accepted", JSON.stringify(created));
      let previousConversation: unknown;
      for (const assignment of [1, 2]) {
        let current = first;
        if (assignment === 2) {
          current = randomUUID();
          await writeFile(join(workspace, "challenge.txt"), current + "\n");
          await unlink(join(workspace, "result.txt"));
          const followed = await host.runtime.execute(
            {
              requestId: "live-follow-up",
              command: {
                kind: "follow_up",
                worker: "worker",
                messageId: "live-follow-up",
                text: "Follow up: read the updated challenge.txt and write result.txt. Report first from your original conversation, and current from the updated file.",
              },
            },
            host.caller,
          );
          assert.equal(followed.status, "accepted", JSON.stringify(followed));
        }
        const ended = await host.runtime.wait({}, host.caller, AbortSignal.timeout(120_000));
        assert.equal(ended.status, "settled", JSON.stringify(ended));
        const result = ended.results.find((entry) => entry.ref.assignment === assignment);
        assert(result, JSON.stringify(ended));
        assert.equal(result.execution.phase, "ended");
        if (result.execution.phase !== "ended") throw new Error("Live assignment did not end");
        assert.equal(result.execution.reason, "completed", JSON.stringify(result));
        assert.equal(result.execution.cleanup, "confirmed", JSON.stringify(result));
        assert.equal(result.usage.complete, true, JSON.stringify(result));
        const usage = result.usage.total;
        assert(usage && usage.input > 0 && usage.output > 0);
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
          const value = usage[key];
          assert(typeof value === "number" && Number.isFinite(value));
          observedUsage[key] += value;
        }
        assert(result.report, JSON.stringify(result));
        const report = JSON.parse(
          Buffer.from(await processArtifacts(host.directory).read(result.report)).toString("utf8"),
        );
        assert.deepEqual(liveReportSchema.parse(report.data), { first, current });
        assert.equal((await readFile(join(workspace, "result.txt"), "utf8")).trim(), current);
        const conversation = await host.runtime.query(
          { kind: "conversation", ref: result.ref },
          host.caller,
        );
        assert.equal(conversation.kind, "conversation");
        if (conversation.kind !== "conversation") throw new Error("Missing live conversation");
        const tools = toolNames(conversation.entries);
        for (const tool of ["read", "write", "submit_result"])
          assert(tools.includes(tool), JSON.stringify(tools));
        if (assignment === 1) previousConversation = conversation;
        else
          assert.deepEqual(
            await host.runtime.query(
              { kind: "conversation", ref: { ...result.ref, assignment: 1 } },
              host.caller,
            ),
            previousConversation,
          );
        reports.push({ backend, assignment, tools, result });
      }
    } finally {
      const shutdown = await host.close("Live OpenAI check finished");
      assert.equal(shutdown.status, "closed", JSON.stringify(shutdown));
    }
  }
  ok = true;
} catch (error) {
  errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  const requestRecords = (
    await Promise.all(
      (await readdir(requests)).map(async (name) =>
        (await readFile(join(requests, name), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ),
    )
  ).flat();
  if (
    ok &&
    (!requestRecords.length ||
      requestRecords.some((entry) => !entry.requestId || entry.status !== 200))
  ) {
    ok = false;
    errors.push("Live provider responses lack successful OpenAI request identities");
  }
  const report = {
    ok,
    provider: "openai",
    model: liveModel,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    limits: liveLimits,
    observedUsage,
    usageComplete: ok,
    requests: requestRecords,
    assignments: reports,
    errors,
  };
  const serialized = JSON.stringify(report, null, 2);
  await writeFile(join(output, "report.json"), serialized + "\n");
  console.log(
    JSON.stringify({
      ok,
      model: liveModel,
      assignments: reports.length,
      requests: requestRecords.length,
      output,
    }),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `OpenAI live check: **${ok ? "passed" : "failed"}**. Model: \`${liveModel}\`. ${reports.length}/4 assignments, ${requestRecords.length} HTTP attempts. Observed usage: ${observedUsage.input} input, ${observedUsage.output} output tokens; $${observedUsage.cost.toFixed(4)}${ok ? "" : " (incomplete)"}.\n`,
    );
  if (!ok) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
