import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openHost } from "../../engine/host/index.ts";
import { dependencyList, readDependency } from "../../engine/agent/dependencies.ts";
import { canonicalJson } from "../../engine/contracts/digest.ts";
import { dependencyPageSchema } from "../../engine/contracts/dependencies.ts";
import type { AssignmentResult } from "../../engine/contracts/lifecycle.ts";
import { piFixture } from "./rewrite-pi-fixture.ts";
import {
  dependencyAnswer,
  installDependencyProvider,
} from "./fixtures/rewrite-dependency-provider.ts";

test("dependency fan-in previews stay bounded while every exact result remains readable", async () => {
  const summary = 'Evidence 🙂 \\"\u0001 with a long retained answer. '.repeat(3000);
  const result: AssignmentResult = {
    ref: { run: "run", worker: "base", assignment: 1 },
    summary,
    execution: { phase: "ended", reason: "completed", cleanup: "confirmed" },
    artifacts: [],
    usage: { expectedAttempts: [], observations: [], complete: true },
  };
  const bytes = Buffer.from(canonicalJson(result));
  const artifact = { digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  const dependencies = Array.from({ length: 1000 }, (_, index) => ({
    ref: { ...result.ref, assignment: index + 1 },
    result: { ...result, ref: { ...result.ref, assignment: index + 1 } },
    artifact,
  }));
  let offset = 0;
  const assignments: number[] = [];
  while (true) {
    const page = dependencyList(dependencies, offset);
    dependencyPageSchema.parse(page);
    assert(Buffer.byteLength(canonicalJson(page)) < 10_000);
    assert(
      page.entries.every(
        (entry) =>
          !entry.summaryComplete && Buffer.from(entry.summary).toString("utf8") === entry.summary,
      ),
    );
    assignments.push(...page.entries.map((entry) => entry.ref.assignment));
    if (page.next === undefined) break;
    offset = page.next;
  }
  assert.deepEqual(
    assignments,
    Array.from({ length: 1000 }, (_, index) => index + 1),
  );
  const launch = {
    brief: { task: "consumer", context: [], dependencies: [dependencies[0]] },
    artifacts: {
      put: async () => artifact,
      read: async () => bytes,
    },
  };
  let text = "";
  offset = 0;
  while (true) {
    const page = await readDependency(launch, { kind: "result", ref: result.ref, offset });
    assert.equal(page.kind, "result");
    if (page.kind !== "result") throw new Error("Expected result page");
    assert(Buffer.byteLength(canonicalJson(page)) <= 32_768);
    assert(page.text.length <= 12_000 && Buffer.from(page.text).toString("utf8") === page.text);
    text += page.text;
    if (page.next === undefined) break;
    offset = page.next;
  }
  assert.equal(text, bytes.toString("utf8"));
  await assert.rejects(
    readDependency(launch, { kind: "result", ref: { ...result.ref, assignment: 2 } }),
    { code: "capability_denied" },
  );
  await assert.rejects(
    readDependency(launch, { kind: "result", ref: result.ref, offset: text.length + 1 }),
    {
      code: "invalid_input",
    },
  );
  const changed = Buffer.from(
    canonicalJson({ ...result, summary: "same ref, changed retained bytes" }),
  );
  await assert.rejects(
    readDependency(
      { ...launch, artifacts: { ...launch.artifacts, read: async () => changed } },
      { kind: "result", ref: result.ref },
    ),
    /integrity failure/,
  );
  await assert.rejects(
    readDependency(launch, { kind: "result", ref: result.ref, artifact }),
    /Unrecognized key/,
  );
  const oversized = dependencies.slice(0, 12).map((entry) => ({
    ...entry,
    ref: { ...entry.ref, run: "界".repeat(1300) },
    result: { ...entry.result, summary: "\u0001".repeat(512) },
  }));
  const seen: number[] = [];
  offset = 0;
  for (;;) {
    const page = dependencyList(oversized, offset);
    assert(Buffer.byteLength(canonicalJson(page)) <= 32_768);
    seen.push(...page.entries.map((entry) => entry.ref.assignment));
    if (page.next === undefined) break;
    assert(page.next > offset, "Each nonterminal page must advance");
    offset = page.next;
  }
  assert.deepEqual(
    seen,
    oversized.map((entry) => entry.ref.assignment),
  );
  assert.throws(
    () => dependencyList([{ ...oversized[0], ref: { ...result.ref, run: "界".repeat(20_000) } }]),
    /page metadata limit/,
  );
  const secondResult = {
    ...result,
    ref: { ...result.ref, assignment: 2 },
    summary: "second result",
  };
  const secondBytes = Buffer.from(canonicalJson(secondResult));
  const secondArtifact = {
    digest: createHash("sha256").update(secondBytes).digest("hex"),
    size: secondBytes.length,
  };
  const twoAssignments = {
    brief: {
      ...launch.brief,
      dependencies: [
        ...launch.brief.dependencies,
        { ref: secondResult.ref, result: secondResult, artifact: secondArtifact },
      ],
    },
    artifacts: {
      ...launch.artifacts,
      read: async (ref: typeof artifact) =>
        ref.digest === secondArtifact.digest ? secondBytes : bytes,
    },
  };
  const secondPage = await readDependency(twoAssignments, {
    kind: "result",
    ref: secondResult.ref,
  });
  assert.equal(secondPage.kind, "result");
  if (secondPage.kind === "result")
    assert.equal(JSON.parse(secondPage.text).summary, "second result");
});

test(
  "a real read-only Pi worker can page its complete predecessor result without an expanded tool grant",
  { timeout: 30_000 },
  async (t) => {
    const answer = "Retained dependency evidence 🙂. ".repeat(2000);
    let text = "";
    let initialBriefLength = 0;
    const world = await piFixture(t, (context) => {
      const messages = JSON.stringify(context.messages);
      if (!messages.includes("DEPENDENT_TASK")) return fauxAssistantMessage(answer);
      const response = context.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "pinata_dependency",
      );
      let offset = 0;
      if (response?.role === "toolResult") {
        const content = response.content.find((entry) => entry.type === "text");
        if (content?.type !== "text") throw new Error("Dependency page was not returned");
        const page = dependencyPageSchema.parse(JSON.parse(content.text));
        if (page.kind !== "result") throw new Error("Expected a result page");
        text += page.text;
        if (page.next === undefined)
          return fauxAssistantMessage("Read complete dependency evidence");
        offset = page.next;
      } else {
        initialBriefLength = messages.length;
        assert(messages.includes("pinata_dependency"));
        assert(!messages.includes(answer));
      }
      return fauxAssistantMessage([
        fauxToolCall("pinata_dependency", {
          kind: "result",
          ref: { run: world.caller.run, worker: "base", assignment: 1 },
          offset,
        }),
      ]);
    });
    const receipt = await world.runtime.execute(
      {
        requestId: "dependency-pages",
        command: {
          kind: "create",
          workers: [
            { id: "base", agent: "fixture", task: "BASE_TASK" },
            { id: "consumer", agent: "fixture", task: "DEPENDENT_TASK", after: ["base"] },
          ],
        },
      },
      world.caller,
    );
    assert.equal(receipt.status, "accepted");
    const result = await world.runtime.wait({}, world.caller, AbortSignal.timeout(25_000));
    assert.equal(result.status, "settled");
    assert(
      result.results.every(
        (entry) => entry.execution.phase === "ended" && entry.execution.reason === "completed",
      ),
    );
    assert(initialBriefLength < 15_000);
    assert.equal(JSON.parse(text).summary, answer);
    const state = await world.runtime.query({ kind: "status" }, world.caller);
    if (state.kind !== "status") throw new Error("Missing state");
    assert.deepEqual(state.state.workers.consumer.tools, ["read"]);
  },
);

test(
  "a process worker receives only scoped dependency result paging without extra file or child tools",
  { skip: !["linux", "darwin"].includes(process.platform), timeout: 40_000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-process-dependency-")));
    const workspace = join(directory, "workspace");
    const agentDir = join(directory, "agent");
    const definitions = join(directory, "definitions");
    await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(definitions)]);
    await writeFile(
      join(definitions, "reader.md"),
      "---\nschemaVersion: 1\nname: reader\nhandoffDescription: Inspect dependency results.\ntools: [read]\npinata:\n  access: read\n---\nRead only the assigned dependency results.\n",
    );
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    installDependencyProvider(modelRuntime, agentDir);
    const host = await openHost({
      workspace,
      directory: join(directory, "run"),
      agentDir,
      definitionDirectories: [definitions],
      modelRuntime,
      bootstrapModule: fileURLToPath(
        new URL("./fixtures/rewrite-dependency-provider.ts", import.meta.url),
      ),
      parentModel: { provider: "dependency-fixture", id: "script", thinking: "off" },
      config: { run: { backend: "process", codemode: false, setup: false } },
    });
    t.after(async () => {
      await host.close("Process dependency test complete");
      await rm(directory, { recursive: true, force: true });
    });
    const receipt = await host.runtime.execute(
      {
        requestId: "process-dependencies",
        command: {
          kind: "create",
          workers: [
            { id: "base", agent: "reader", task: "PROCESS_BASE_TASK" },
            { id: "consumer", agent: "reader", task: "PROCESS_DEPENDENT_TASK", after: ["base"] },
          ],
        },
      },
      host.caller,
    );
    assert.equal(receipt.status, "accepted");
    const ended = await host.runtime.wait({}, host.caller, AbortSignal.timeout(30_000));
    assert.equal(
      ended.status,
      "settled",
      JSON.stringify({ wait: ended, diagnostics: host.runtime.diagnostics() }),
    );
    assert(
      ended.results.every(
        (result) => result.execution.phase === "ended" && result.execution.reason === "completed",
      ),
      JSON.stringify(ended),
    );
    const observation = JSON.parse(
      await readFile(join(agentDir, "dependency-observed.json"), "utf8"),
    );
    assert.equal(observation.summary, dependencyAnswer);
    assert(observation.pages > 1 && observation.initialBriefBytes < 15_000);
    assert.deepEqual(observation.tools.sort(), ["pinata_dependency", "read", "submit_result"]);
    const state = await host.runtime.query({ kind: "status" }, host.caller);
    assert(state.kind === "status");
    assert.equal(state.state.workers.consumer.access, "read");
    assert.deepEqual(state.state.workers.consumer.tools, ["read"]);
  },
);
