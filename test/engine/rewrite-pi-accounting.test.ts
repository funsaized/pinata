import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  assignmentKey,
  type AssignmentResult,
  type CommandReceipt,
} from "../../engine/contracts/index.ts";
import { verifyArtifact } from "../../engine/storage/index.ts";
import { piFixture } from "./rewrite-pi-fixture.ts";

function accepted(receipt: CommandReceipt): void {
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
}

async function toolExtension(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pinata-accounting-extension-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "extension.mjs");
  await writeFile(
    path,
    `export default function (pi) {
    for (const name of ["metered_fixture", "unmetered_fixture"]) {
      pi.registerTool({
        name, label: name, description: "Scripted accounting fixture; no provider requests.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return {
            content: [{ type: "text", text: name + " result" }], details: {},
            ...(name === "metered_fixture" ? { usage: {
              input: 1000, output: 30, cacheRead: 5, cacheWrite: 0, totalTokens: 1035,
              cost: { input: 1, output: 0.3, cacheRead: 0.005, cacheWrite: 0, total: 1.305 }
            }} : {})
          };
        }
      });
    }
  }`,
  );
  return path;
}

const transcriptSchema = z.object({
  entries: z.array(z.looseObject({ type: z.string(), message: z.unknown().optional() })),
});
const messageSchema = z.looseObject({
  role: z.string(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  usage: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      cost: z.object({ total: z.number() }),
    })
    .optional(),
});
async function transcriptMessages(directory: string, result: AssignmentResult) {
  assert(result.transcript, "assignment retains its full transcript");
  const transcript = transcriptSchema.parse(
    JSON.parse((await verifyArtifact(directory, result.transcript)).toString("utf8")),
  );
  return transcript.entries
    .filter((entry) => entry.type === "message")
    .map((entry) => messageSchema.parse(entry.message));
}

test(
  "replacement Pi accounting includes custom tool usage exactly once beside provider responses",
  { timeout: 30_000 },
  async (t) => {
    const extension = await toolExtension(t);
    const fixture = await piFixture(
      t,
      (_context, _options, state) =>
        state.callCount === 1
          ? fauxAssistantMessage([fauxToolCall("metered_fixture", {}, { id: "metered-call" })], {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage([fauxText("Finished the scripted tool")]),
      { tools: ["metered_fixture"], extensions: [extension] },
    );
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "add",
          command: {
            kind: "add",
            workers: [{ id: "base", agent: "fixture", task: "Use the metered fixture tool" }],
          },
        },
        fixture.caller,
      ),
    );
    const waited = await fixture.runtime.wait(
      { workers: ["base"] },
      fixture.caller,
      AbortSignal.timeout(20_000),
    );
    assert.equal(waited.status, "settled", JSON.stringify(fixture.runtime.diagnostics()));
    assert.equal(waited.results.length, 1);
    const result = waited.results[0];
    assert.equal(result.execution.phase === "ended" && result.execution.reason, "completed");
    const messages = await transcriptMessages(fixture.storeDirectory, result);
    const tool = messages.find(
      (message) => message.role === "toolResult" && message.toolName === "metered_fixture",
    );
    assert.equal(tool?.usage?.input, 1000, "Pi actually retained the custom tool's measured usage");
    const measured = messages.flatMap((message) => (message.usage ? [message.usage] : []));
    assert.equal(result.usage.complete, true);
    assert.equal(
      result.usage.total?.input,
      measured.reduce((sum, entry) => sum + entry.input, 0),
    );
    assert.equal(
      result.usage.total?.cacheRead,
      measured.reduce((sum, entry) => sum + entry.cacheRead, 0),
    );
    assert.equal(
      result.usage.total?.cost,
      measured.reduce((sum, entry) => sum + entry.cost.total, 0),
    );
    assert.equal(
      result.usage.observations.filter(
        (entry) => entry.kind === "response" && entry.usage.input === 1000,
      ).length,
      1,
    );
  },
);

test(
  "replacement Pi accounting marks a custom tool without usage coverage unknown",
  { timeout: 30_000 },
  async (t) => {
    const extension = await toolExtension(t);
    const fixture = await piFixture(
      t,
      (_context, _options, state) =>
        state.callCount === 1
          ? fauxAssistantMessage(
              [fauxToolCall("unmetered_fixture", {}, { id: "unmetered-call" })],
              { stopReason: "toolUse" },
            )
          : fauxAssistantMessage("Finished with unobserved tool usage"),
      { tools: ["unmetered_fixture"], extensions: [extension] },
    );
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "add",
          command: {
            kind: "add",
            workers: [{ id: "base", agent: "fixture", task: "Use the unmetered fixture tool" }],
          },
        },
        fixture.caller,
      ),
    );
    const waited = await fixture.runtime.wait({}, fixture.caller, AbortSignal.timeout(20_000));
    assert.equal(waited.status, "settled", JSON.stringify(fixture.runtime.diagnostics()));
    const result = waited.results[0];
    const messages = await transcriptMessages(fixture.storeDirectory, result);
    assert(
      messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "unmetered_fixture" &&
          !message.isError,
      ),
    );
    assert.equal(result.execution.phase === "ended" && result.execution.reason, "completed");
    assert.equal(result.usage.complete, false);
    assert.equal(result.usage.total, null);
    assert(result.usage.observations.length > 0, "known provider usage remains inspectable");
  },
);

test(
  "replacement Pi cancellation retains partial evidence without claiming complete usage",
  { timeout: 30_000 },
  async (t) => {
    let enter = (): void => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const fixture = await piFixture(t, async (_context, options) => {
      assert(options?.signal);
      const signal = options.signal;
      enter();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("Interrupted scripted response");
    });
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "add",
          command: {
            kind: "add",
            workers: [{ id: "base", agent: "fixture", task: "Wait for explicit cancellation" }],
          },
        },
        fixture.caller,
      ),
    );
    await entered;
    accepted(
      await fixture.runtime.execute(
        { requestId: "cancel", command: { kind: "cancel", scope: "worker", worker: "base" } },
        fixture.caller,
      ),
    );
    const waited = await fixture.runtime.wait({}, fixture.caller, AbortSignal.timeout(20_000));
    assert.equal(waited.status, "settled", JSON.stringify(fixture.runtime.diagnostics()));
    const result = waited.results[0];
    assert.equal(result.execution.phase === "ended" && result.execution.reason, "cancelled");
    assert.equal(result.execution.phase === "ended" && result.execution.cleanup, "confirmed");
    assert.equal(result.usage.complete, false);
    assert.equal(result.usage.total, null);
    assert(
      result.session || result.transcript,
      "partial conversation evidence survives cancellation",
    );
  },
);

test(
  "replacement Pi reports preserve worker claims as data without granting acceptance or authority",
  { timeout: 30_000 },
  async (t) => {
    const report = {
      summary: "The requested check failed",
      assessment: { claimedChecks: ["A claimed check"], blockers: ["Tests are failing"] },
      data: { status: "approved", cleanup: "stopped", grant: "write" },
    };
    const fixture = await piFixture(t, () =>
      fauxAssistantMessage([fauxToolCall("submit_result", report, { id: "report" })], {
        stopReason: "toolUse",
      }),
    );
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "add",
          command: {
            kind: "add",
            workers: [{ id: "base", agent: "fixture", task: "Report the fixture findings" }],
          },
        },
        fixture.caller,
      ),
    );
    const waited = await fixture.runtime.wait({}, fixture.caller, AbortSignal.timeout(20_000));
    assert.equal(waited.status, "settled", JSON.stringify(fixture.runtime.diagnostics()));
    const result = waited.results[0];
    assert(result.report);
    assert.deepEqual(
      JSON.parse((await verifyArtifact(fixture.storeDirectory, result.report)).toString("utf8")),
      report,
    );
    assert.equal(result.execution.phase === "ended" && result.execution.reason, "completed");
    assert.equal(Object.hasOwn(result, "acceptance"), false);
    assert.equal(Object.hasOwn(result, "correctness"), false);
    const status = await fixture.runtime.query({ kind: "status" }, fixture.caller);
    assert.equal(status.kind, "status");
    if (status.kind !== "status") return;
    assert.equal(status.state.workers.base.grants.access, "read");
    assert.equal(status.state.results[assignmentKey(result.ref)].result.summary, report.summary);
  },
);

test(
  "replacement Pi retains malformed optional report errors and still returns the final conversation",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await piFixture(t, (_context, _options, state) =>
      state.callCount === 1
        ? fauxAssistantMessage(
            [
              fauxToolCall(
                "submit_result",
                { summary: "invalid report", cleanup: "confirmed" },
                { id: "bad-report" },
              ),
            ],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage(
            "Finished with a plain-text result after the optional report failed",
          ),
    );
    accepted(
      await fixture.runtime.execute(
        {
          requestId: "add",
          command: {
            kind: "add",
            workers: [
              { id: "base", agent: "fixture", task: "Exercise malformed optional reporting" },
            ],
          },
        },
        fixture.caller,
      ),
    );
    const waited = await fixture.runtime.wait({}, fixture.caller, AbortSignal.timeout(20_000));
    assert.equal(waited.status, "settled", JSON.stringify(fixture.runtime.diagnostics()));
    const result = waited.results[0];
    const messages = await transcriptMessages(fixture.storeDirectory, result);
    assert(
      messages.some(
        (message) =>
          message.role === "toolResult" && message.toolName === "submit_result" && message.isError,
      ),
    );
    assert.equal(result.execution.phase === "ended" && result.execution.reason, "completed");
    assert.equal(result.report, undefined);
    assert.match(result.reportingError ?? "", /cleanup|additional|unexpected|unrecognized/i);
    const retained = await Promise.all(
      result.artifacts.map(async (artifact) =>
        (await verifyArtifact(fixture.storeDirectory, artifact)).toString("utf8"),
      ),
    );
    assert(
      retained.some((bytes) => bytes.includes('"cleanup":"confirmed"')),
      "malformed model output is retained as data rather than becoming authority",
    );
    assert.match(result.summary, /plain-text result/);
  },
);
