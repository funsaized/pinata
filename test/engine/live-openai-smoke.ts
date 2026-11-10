// Paid Pinata/Pi contract check. Ordinary npm test never invokes this entry point.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assignmentKey,
  type AssignmentResult,
  type QueryResult,
  type RuntimeQuery,
} from "../../engine/contracts/index.ts";
import { openHost } from "../../engine/host/index.ts";
import { processArtifacts } from "../../engine/backends/process-transport.ts";
import { openSavedSource } from "../../engine/sources/saved.ts";
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
// Pi credentials and personal settings stay outside the uploaded evidence tree.
const agentDir = await mkdtemp(join(tmpdir(), "pinata-live-agent-"));
const workspace = join(output, "workspace");
const directory = join(output, "run");
const definitions = join(output, "definitions");
const assignments: AssignmentResult[] = [];
const queries: { query: RuntimeQuery; expected: QueryResult }[] = [];
const observedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const responseIds = new Set<string>();
const attemptIds = new Set<string>();
const errors: string[] = [];
let replayVerified = false;

function recordUsage(result: AssignmentResult): void {
  assert.equal(result.usage.complete, true, JSON.stringify(result.usage));
  assert.equal(result.usage.expectedAttempts.length, 1);
  const attempt = result.usage.expectedAttempts[0];
  assert(attempt.startsWith(`${assignmentKey(result.ref)}/attempt/`));
  assert(!attemptIds.has(attempt), "Follow-up reused an earlier attempt's usage");
  attemptIds.add(attempt);
  assert(result.usage.observations.every((observation) => observation.attempt === attempt));
  const responses = result.usage.observations.filter(
    (observation) => observation.kind === "response",
  );
  assert(responses.length > 0);
  for (const response of responses) {
    assert(response.responseId && !responseIds.has(response.responseId));
    responseIds.add(response.responseId);
  }
  const total = result.usage.total;
  assert(total && total.input > 0 && total.output > 0);
  // Pinata receives both per-response usage and a final attempt total. Count each response once.
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
    const value = total[key];
    assert(typeof value === "number" && Number.isFinite(value));
    const summed = responses.reduce((sum, response) => {
      const measured = response.usage[key];
      assert(typeof measured === "number");
      return sum + measured;
    }, 0);
    assert(Math.abs(value - summed) < 1e-9, `${key} was lost or counted twice`);
    observedUsage[key] += value;
  }
}

try {
  await Promise.all([mkdir(workspace), mkdir(definitions)]);
  const first = randomUUID();
  await writeFile(join(workspace, "challenge.txt"), first + "\n");
  const host = await openHost({
    directory,
    workspace,
    agentDir,
    definitionDirectories: [definitions],
    bootstrapModule: fileURLToPath(new URL("./fixtures/live-openai-agent.ts", import.meta.url)),
    parentModel: { provider: "openai", id: liveModel, thinking: "off" },
    config: { run: { backend: "process", codemode: false, setup: false } },
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
              task: "Read challenge.txt and submit the initial typed report.",
            },
          ],
        },
      },
      host.caller,
    );
    assert.equal(created.status, "accepted", JSON.stringify(created));
    const status = await host.runtime.query({ kind: "status" }, host.caller);
    assert.equal(status.kind, "status");
    if (status.kind !== "status") throw new Error("Missing accepted worker");
    const worker = status.state.workers.worker;
    assert.equal(worker.backend, "process");
    assert.deepEqual(worker.model, { provider: "openai", id: liveModel, thinking: "off" });
    assert.equal(worker.grants.access, "read");
    assert.deepEqual(worker.tools, ["read"]);

    for (const assignment of [1, 2]) {
      let current = first;
      if (assignment === 2) {
        current = randomUUID();
        await writeFile(join(workspace, "challenge.txt"), current + "\n");
        const followed = await host.runtime.execute(
          {
            requestId: "live-follow-up",
            command: {
              kind: "follow_up",
              worker: "worker",
              messageId: "live-follow-up",
              text: "Follow up: read the updated challenge.txt. Report first from your original conversation, and current from the updated file.",
            },
          },
          host.caller,
        );
        assert.equal(followed.status, "accepted", JSON.stringify(followed));
      }
      const ended = await host.runtime.wait({}, host.caller, AbortSignal.timeout(120_000));
      assert.equal(ended.status, "settled", JSON.stringify(ended));
      const result = ended.results.find((entry) => entry.ref.assignment === assignment);
      assert(result && result.ref.worker === "worker", JSON.stringify(ended));
      assert.deepEqual(
        result.execution,
        { phase: "ended", reason: "completed", cleanup: "confirmed" },
        JSON.stringify(result),
      );
      assert(
        result.report && !result.reportingError && !result.finalizationErrors?.length,
        JSON.stringify(result),
      );
      const report = JSON.parse(
        Buffer.from(await processArtifacts(host.directory).read(result.report)).toString("utf8"),
      );
      assert.deepEqual(liveReportSchema.parse(report.data), { first, current });
      recordUsage(result);
      // The later assignment must not replace earlier result or conversation artifacts.
      for (const { query, expected } of queries)
        assert.deepEqual(await host.runtime.query(query, host.caller), expected);
      for (const kind of ["result", "conversation"] as const) {
        const query = { kind, ref: result.ref };
        const expected = await host.runtime.query(query, host.caller);
        assert.equal(expected.kind, kind);
        if (expected.kind === "result") assert.deepEqual(expected.result, result);
        else if (expected.kind === "conversation") {
          assert.deepEqual(expected.ref, result.ref);
          assert.equal(expected.source, "assignment");
          assert.equal(expected.complete, true);
          assert(expected.entries.length > 0);
          assert(JSON.stringify(expected.entries).includes(current));
        }
        queries.push({ query, expected: structuredClone(expected) });
      }
      assignments.push(result);
    }
  } finally {
    try {
      const shutdown = await host.close("Live Pinata/Pi contract check finished");
      assert.equal(shutdown.status, "closed", JSON.stringify(shutdown));
    } catch (error) {
      errors.push(`Shutdown: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  const saved = await openSavedSource(directory);
  for (const { query, expected } of queries) {
    const reply = await saved.request({ method: "query", input: query });
    assert.equal(reply.status, "ok", JSON.stringify(reply));
    if (reply.status !== "ok" || reply.response.method !== "query")
      throw new Error("Saved query failed");
    assert.deepEqual(reply.response.result, expected);
  }
  replayVerified = true;
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
    !requestRecords.length ||
    requestRecords.some((entry) => !entry.requestId || entry.status !== 200)
  )
    errors.push("Live provider responses lack successful OpenAI request identities");
  if (requestRecords.length !== responseIds.size)
    errors.push("HTTP attempts and assignment-attributed response usage do not match");
  const ok = errors.length === 0 && assignments.length === 2 && replayVerified;
  const report = {
    ok,
    provider: "openai",
    model: liveModel,
    backend: "process",
    platform: process.platform,
    node: process.version,
    limits: liveLimits,
    observedUsage,
    usageComplete: ok,
    replayVerified,
    requests: requestRecords,
    assignments,
    errors,
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      ok,
      assignments: assignments.length,
      requests: requestRecords.length,
      replayVerified,
      output,
    }),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Pinata/Pi live contract: **${ok ? "passed" : "failed"}**. Process backend; \`${liveModel}\`. ${assignments.length}/2 assignments; ${requestRecords.length} HTTP attempts. Typed reports, usage attribution, cleanup and saved replay: ${ok ? "verified" : "incomplete"}. Observed cost: $${observedUsage.cost.toFixed(4)}${ok ? "" : " (incomplete)"}.\n`,
    );
  if (!ok) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
