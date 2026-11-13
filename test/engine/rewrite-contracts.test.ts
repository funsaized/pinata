import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import type { TSchema } from "typebox";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import {
  assignmentKey,
  commandEnvelopeSchema,
  configSchema,
  definitionSchema,
  digestValue,
  exportSchemas,
  frozenWorkerSchema,
  journalRecordSchema,
  journalFrameSchema,
  versions,
  type AssignmentResult,
  type CallerAuthority,
  type CommandEnvelope,
  type FrozenWorker,
  type Transition,
} from "../../engine/contracts/index.ts";
import { prepareCommand } from "../../engine/core/accept.ts";
import {
  dependencyResults,
  initialState,
  reduce,
  type CoreState,
} from "../../engine/core/state.ts";
import { assignmentUsage } from "../../engine/core/usage.ts";

const definition = { digest: digestValue("definition"), size: 12 };
const grants = {
  access: "write" as const,
  tools: ["read", "edit"],
  workspaces: ["shared" as const, "worktree" as const],
  inheritContext: false,
  memory: { scope: "none" as const, access: "read" as const },
  delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
};
const caller: CallerAuthority = { id: "coordinator", kind: "coordinator", run: "run", grants };
function worker(id: string): FrozenWorker {
  return frozenWorkerSchema.parse({
    id,
    agent: "builder",
    definition,
    tools: grants.tools,
    fallbacks: [],
    access: "write",
    workspace: "shared",
    backend: "in-process",
    lifetime: "attached",
    grants,
  });
}
function request(requestId: string, command: unknown): CommandEnvelope {
  return commandEnvelopeSchema.parse({ requestId, command });
}
function add(state: CoreState, id: string): CoreState {
  const accepted = prepareCommand(
    state,
    request(`add-${id}`, { kind: "add", workers: [{ id, agent: "builder", task: id }] }),
    caller,
    { workers: [worker(id)] },
  );
  return reduce(state, accepted, state.revision + 1);
}
function settle(
  state: CoreState,
  assignment: number,
  summary: string,
  history?: Transition[],
): CoreState {
  const ref = { run: "run", worker: "base", assignment };
  const attemptId = `base/${assignment}/attempt`;
  let current = state;
  const commit = (transition: Transition) => {
    history?.push(transition);
    current = reduce(current, transition, current.revision + 1);
  };
  commit({ kind: "assignment_state", ref, execution: { phase: "preparing" } });
  commit({
    kind: "attempt_started",
    attempt: { id: attemptId, ref, ordinal: 1, backend: "in-process", ownerEpoch: "epoch" },
  });
  commit({
    kind: "backend_enrolled",
    attemptId,
    identity: { id: attemptId, kind: "in-process", ownerEpoch: "epoch" },
    evidence: [definition],
  });
  commit({ kind: "assignment_state", ref, execution: { phase: "running" } });
  const outcome = {
    reason: "completed" as const,
    summary,
    usage: {
      expectedAttempts: [attemptId],
      observations: [
        {
          attempt: attemptId,
          source: attemptId,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        },
      ],
      complete: true,
    },
    artifacts: [],
  };
  commit({
    kind: "attempt_outcome",
    attemptId,
    outcome,
    artifact: { digest: digestValue(outcome), size: JSON.stringify(outcome).length },
  });
  commit({ kind: "assignment_state", ref, execution: { phase: "finalizing" } });
  commit({
    kind: "cleanup_observed",
    attemptId,
    receipt: {
      status: "stopped",
      ownerEpoch: "epoch",
      identities: [attemptId],
      evidence: [definition],
    },
  });
  const result: AssignmentResult = {
    ref,
    summary,
    execution: { phase: "ended", reason: "completed", cleanup: "confirmed" },
    artifacts: [],
    usage: assignmentUsage(current, ref),
  };
  commit({
    kind: "settled",
    result,
    resultArtifact: { digest: digestValue(result), size: JSON.stringify(result).length },
    notificationId: `run/base/${assignment}/completed`,
  });
  return current;
}

test("rewrite contracts freeze independent format versions and strict authority-free command inputs", () => {
  assert.deepEqual(versions, {
    job: 1,
    config: 1,
    definition: 1,
    manifest: 1,
    journal: 1,
    event: 1,
    ipc: 1,
  });
  for (const name of Object.keys(exportSchemas())) assert.match(name, /\.v1$/);
  const config = configSchema.parse({});
  assert.equal(config.workspace, "shared");
  assert.equal(config.execution.maxConcurrent, null);
  assert.equal(config.ui.palette, "inherit");
  assert.throws(() => configSchema.parse({ execution: { maxConcurrent: 0 } }));
  assert.throws(() => configSchema.parse({ limits: {} }));
  assert.throws(() => configSchema.parse({ passEnv: ["NODE_OPTIONS"] }));
  const input = {
    requestId: "one",
    command: { kind: "add", workers: [{ id: "base", agent: "builder", task: "implement" }] },
  };
  assert.throws(() => commandEnvelopeSchema.parse({ ...input, authority: grants }));
  assert.throws(() => commandEnvelopeSchema.parse({ ...input, backend: "process" }));
  assert.throws(() =>
    commandEnvelopeSchema.parse({
      ...input,
      command: { ...input.command, workers: [{ ...input.command.workers[0], grants }] },
    }),
  );
  assert.throws(() =>
    definitionSchema.parse({
      schemaVersion: 2,
      name: "builder",
      instructions: "work",
      handoffDescription: "Build",
    }),
  );
});

test("rewrite JSON schema bridge works through Pi validation then canonical validation", () => {
  const schemas = exportSchemas();
  assert(Object.keys(schemas).length >= 18);
  const parameters = schemas["pinata.command.v1"] as TSchema;
  const tool = { name: "pinata_test", description: "Scripted contract only", parameters };
  const parse = (value: JsonObject) =>
    commandEnvelopeSchema.parse(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "test",
        name: tool.name,
        arguments: value,
      }),
    );
  assert.equal(
    parse({ requestId: "one", command: { kind: "capacity", maxConcurrent: "2" } }).command.kind,
    "capacity",
  );
  assert.throws(() =>
    commandEnvelopeSchema.parse({
      requestId: "one",
      command: { kind: "capacity", maxConcurrent: "2" },
    }),
  );
  assert.throws(() => parse({ requestId: "one", command: { kind: "add", workers: [] } }));
  assert.throws(() =>
    parse({ requestId: "one", command: { kind: "capacity", maxConcurrent: 2, authority: "root" } }),
  );
});

test("rewrite F3 rejects exact missing references without reserving names or changing accepted state", () => {
  const state = add(initialState("run"), "base");
  const before = structuredClone(state);
  assert.throws(
    () =>
      prepareCommand(
        state,
        request("bad", {
          kind: "add",
          workers: [
            {
              id: "audit",
              agent: "builder",
              task: "audit",
              after: [{ run: "run", worker: "base", assignment: 999 }],
            },
          ],
        }),
        caller,
        { workers: [worker("audit")] },
      ),
    { code: "dependency_missing" },
  );
  assert.deepEqual(state, before);
  const accepted = prepareCommand(
    state,
    request("corrected", {
      kind: "add",
      workers: [{ id: "audit", agent: "builder", task: "audit", after: ["base"] }],
    }),
    caller,
    { workers: [worker("audit")] },
  );
  const next = reduce(state, accepted, 2);
  assert.deepEqual(
    next.assignments[assignmentKey({ run: "run", worker: "audit", assignment: 1 })].after,
    [{ run: "run", worker: "base", assignment: 1 }],
  );
  assert.equal(next.latest.audit, 1);
  assert.equal(Object.keys(next.inbox).length, 2);
  assert.equal(Object.keys(state.workers).length, 1);
});

test("rewrite batches resolve forward names, reject cycles and enforce FIFO against latest accepted assignments", () => {
  const empty = initialState("run");
  assert.throws(
    () =>
      prepareCommand(
        empty,
        request("cycle", {
          kind: "add",
          workers: [
            { id: "a", agent: "builder", task: "a", after: ["b"] },
            { id: "b", agent: "builder", task: "b", after: ["a"] },
          ],
        }),
        caller,
        { workers: [worker("a"), worker("b")] },
      ),
    { code: "invalid_input" },
  );
  const batch = prepareCommand(
    empty,
    request("batch", {
      kind: "add",
      workers: [
        { id: "a", agent: "builder", task: "a", after: ["b"] },
        { id: "b", agent: "builder", task: "b" },
      ],
    }),
    caller,
    { workers: [worker("a"), worker("b")] },
  );
  assert.equal(batch.assignments[0].after[0].worker, "b");
  let state = reduce(empty, batch, 1);
  const follow = prepareCommand(
    state,
    request("follow", {
      kind: "follow_up",
      worker: "b",
      messageId: "follow-message",
      text: "again",
    }),
    caller,
  );
  state = reduce(state, follow, 2);
  assert.deepEqual(follow.assignments[0].after, [{ run: "run", worker: "b", assignment: 1 }]);
  const later = prepareCommand(
    state,
    request("later", {
      kind: "add",
      workers: [{ id: "c", agent: "builder", task: "c", after: ["b"] }],
    }),
    caller,
    { workers: [worker("c")] },
  );
  assert.equal(later.assignments[0].after[0].assignment, 2);
  assert.equal(
    state.assignments[assignmentKey({ run: "run", worker: "a", assignment: 1 })].after[0]
      .assignment,
    1,
  );
});

test("rewrite A1 keeps both immutable predecessor results through follow-up and replay", () => {
  const acceptedBase = prepareCommand(
    initialState("run"),
    request("add-base", { kind: "add", workers: [{ id: "base", agent: "builder", task: "base" }] }),
    caller,
    { workers: [worker("base")] },
  );
  const transitions: Transition[] = [acceptedBase];
  let state = settle(reduce(initialState("run"), acceptedBase, 1), 1, "first summary", transitions);
  const follow = prepareCommand(
    state,
    request("follow", { kind: "follow_up", worker: "base", messageId: "second", text: "second" }),
    caller,
  );
  transitions.push(follow);
  state = settle(reduce(state, follow, state.revision + 1), 2, "second summary", transitions);
  const accepted = prepareCommand(
    state,
    request("audit", {
      kind: "add",
      workers: [
        {
          id: "audit",
          agent: "builder",
          task: "audit",
          after: [
            { run: "run", worker: "base", assignment: 1 },
            { run: "run", worker: "base", assignment: 2 },
          ],
        },
      ],
    }),
    caller,
    { workers: [worker("audit")] },
  );
  const summaries = dependencyResults(state, accepted.assignments[0]);
  assert.deepEqual(
    summaries.map((entry) => entry.result.summary),
    ["first summary", "second summary"],
  );
  assert.notEqual(summaries[0].artifact.digest, summaries[1].artifact.digest);
  summaries[0].result.summary = "untrusted caller edit";
  assert.equal(
    dependencyResults(state, accepted.assignments[0])[0].result.summary,
    "first summary",
  );
  const replayed = transitions.reduce(
    (replay, transition, index) => reduce(replay, transition, index + 1),
    initialState("run"),
  );
  assert.deepEqual(
    dependencyResults(replayed, accepted.assignments[0]),
    dependencyResults(state, accepted.assignments[0]),
  );
});

test("rewrite inbox identity is independent of text and steer chooses earliest pending assignment", () => {
  let state = add(initialState("run"), "base");
  const follow = prepareCommand(
    state,
    request("follow", { kind: "follow_up", worker: "base", messageId: "next", text: "same" }),
    caller,
  );
  state = reduce(state, follow, 2);
  const steer = prepareCommand(
    state,
    request("steer", { kind: "steer", worker: "base", messageId: "steer", text: "same" }),
    caller,
  );
  assert.equal(steer.assignments.length, 0);
  assert.equal(steer.messages[0].target.assignment, 1);
  state = reduce(state, steer, 3);
  assert.equal(state.latest.base, 2);
  assert.throws(
    () =>
      prepareCommand(
        state,
        request("duplicate", {
          kind: "follow_up",
          worker: "base",
          messageId: "next",
          text: "same",
        }),
        caller,
      ),
    { code: "conflict" },
  );
});

test("rewrite safe record keys preserve constructor workers and arbitrary request/message identities", () => {
  const state = initialState("run");
  const accepted = prepareCommand(
    state,
    request("__proto__", {
      kind: "add",
      workers: [{ id: "constructor", agent: "builder", task: "work", messageId: "__proto__" }],
    }),
    caller,
    { workers: [worker("constructor")] },
  );
  const next = reduce(state, accepted, 1);
  assert.equal(next.latest.constructor, 1);
  assert.equal(Object.hasOwn(next.receipts, "__proto__"), true);
  assert.equal(Object.hasOwn(next.inbox, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(next.receipts), Object.prototype);
  assert.equal(next.inbox.__proto__.text, "work");
});

test("rewrite grants cannot expand through frozen resolution or command data", () => {
  const requestValue = request("add", {
    kind: "add",
    workers: [{ id: "base", agent: "builder", task: "work" }],
  });
  const frozen = worker("base");
  assert.throws(
    () =>
      prepareCommand(
        initialState("run"),
        requestValue,
        { ...caller, kind: "viewer" },
        { workers: [frozen] },
      ),
    { code: "capability_denied" },
  );
  assert.throws(
    () =>
      prepareCommand(
        initialState("run"),
        requestValue,
        { ...caller, grants: { ...grants, access: "read" } },
        { workers: [frozen] },
      ),
    { code: "capability_denied" },
  );
  assert.throws(
    () =>
      prepareCommand(initialState("run"), requestValue, caller, {
        workers: [{ ...frozen, tools: ["write-secret"] }],
      }),
    { code: "capability_denied" },
  );
  assert.throws(
    () =>
      prepareCommand(initialState("run"), requestValue, caller, {
        workers: [{ ...frozen, lifetime: "surviving" }],
      }),
    { code: "unsupported" },
  );
});

test("rewrite committed records bind receipts and audit every referenced artifact", () => {
  const accepted = prepareCommand(
    initialState("run"),
    request("add", { kind: "add", workers: [{ id: "base", agent: "builder", task: "work" }] }),
    caller,
    { workers: [worker("base")] },
  );
  const record = {
    schemaVersion: 1,
    revision: 1,
    requestId: "add",
    payloadDigest: accepted.payloadDigest,
    previousDigest: "",
    transition: accepted,
    artifacts: [definition],
  };
  assert.equal(journalRecordSchema.parse(record).revision, 1);
  assert.throws(() => journalRecordSchema.parse({ ...record, artifacts: [] }));
  assert.throws(() => journalRecordSchema.parse({ ...record, requestId: "different" }));
  assert.throws(() => journalRecordSchema.parse({ ...record, revision: 2 }));
  assert.throws(() => journalRecordSchema.parse({ ...record, payloadDigest: "a".repeat(64) }));
  const conflicting = structuredClone(record);
  conflicting.transition.workers[0].context = { ...definition, size: definition.size + 1 };
  assert.throws(() => journalRecordSchema.parse(conflicting));
  conflicting.artifacts.push({ ...definition, size: definition.size + 1 });
  assert.throws(() => journalRecordSchema.parse(conflicting));
});

test("rewrite reducer records effect uncertainty and refuses fabricated consumption or repeated settlement", () => {
  let state = add(initialState("run"), "base");
  const ref = { run: "run", worker: "base", assignment: 1 };
  const intent: Transition = {
    kind: "effect_intent",
    effect: { id: "prepare", kind: "prepare", ref },
  };
  const before = state;
  state = reduce(state, intent, 2);
  assert.equal(Object.keys(before.effects).length, 0);
  assert.equal(state.effects.prepare.status, "intent");
  state = reduce(state, { kind: "effect_observed", effectId: "prepare", status: "uncertain" }, 3);
  assert.equal(state.effects.prepare.status, "uncertain");
  assert.throws(
    () =>
      reduce(
        state,
        {
          kind: "inbox_state",
          messageId: "add-base/base/initial",
          attemptId: "attempt",
          state: "consumed",
        },
        4,
      ),
    { code: "conflict" },
  );
  state = reduce(
    state,
    { kind: "effect_observed", effectId: "prepare", status: "completed" },
    state.revision + 1,
  );
  state = settle(state, 1, "done");
  assert.throws(() => settle(state, 1, "again"), { code: "conflict" });
});

test("rewrite replay rejects semantically corrupt committed acceptances even with recomputed frame digests", () => {
  const original = prepareCommand(
    initialState("run"),
    request("add", { kind: "add", workers: [{ id: "base", agent: "builder", task: "work" }] }),
    caller,
    { workers: [worker("base")] },
  );
  const altered = [
    (transition: typeof original) => {
      transition.receipt.assignments[0].assignment = 999;
    },
    (transition: typeof original) => {
      transition.receipt.resolved[0].workspace = "worktree";
    },
    (transition: typeof original) => {
      transition.assignments[0].after.push({ run: "run", worker: "missing", assignment: 1 });
    },
    (transition: typeof original) => {
      transition.assignments[0].after.push({ run: "run", worker: "base", assignment: 1 });
    },
    (transition: typeof original) => {
      transition.messages[0].text = "different initial message";
    },
    (transition: typeof original) => {
      transition.messages[0].state = "consumed";
    },
  ];
  for (const alter of altered) {
    const transition = structuredClone(original);
    alter(transition);
    const record = {
      schemaVersion: 1,
      revision: 1,
      requestId: "add",
      payloadDigest: transition.payloadDigest,
      previousDigest: "",
      transition,
      artifacts: [definition],
    };
    const frame = journalFrameSchema.parse({
      record,
      digest: digestValue(record),
      commit: "pinata.commit.v1",
    });
    assert.equal(frame.digest, digestValue(frame.record));
    assert.throws(() =>
      reduce(initialState("run"), frame.record.transition, frame.record.revision),
    );
  }
  const base = reduce(initialState("run"), original, 1);
  const follow = prepareCommand(
    base,
    request("follow", { kind: "follow_up", worker: "base", messageId: "follow", text: "again" }),
    caller,
  );
  follow.assignments[0].after = [];
  assert.throws(() => reduce(base, follow, 2), /FIFO predecessor/);
});

test("production import graph has one runtime and keeps core independent of side effects and Pi", async () => {
  await assert.rejects(readdir("rewrite"), { code: "ENOENT" });
  for (const retired of [
    "engine/core/engine.ts",
    "engine/pi/pipeline.ts",
    "engine/verify",
    "engine/migrate",
  ])
    await assert.rejects(readFile(retired), { code: "ENOENT" });
  const stagedRoot = resolve("rewrite") + sep;
  const pureLayers = ["core", "contracts", "runtime", "storage"];
  for (const file of await readdir("engine", { recursive: true })) {
    if (!/\.(ts|mjs)$/.test(file)) continue;
    const path = join("engine", file);
    const layer = file.split(sep)[0];
    const source = await readFile(path, "utf8");
    const imports = [
      ...source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of imports) {
      if (pureLayers.includes(layer))
        assert(!specifier.startsWith("@earendil"), `${path} imports Pi: ${specifier}`);
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(path), specifier);
        assert(
          !target.startsWith(stagedRoot),
          `${path} imports removed staging source: ${specifier}`,
        );
        await readFile(target);
      }
      if (layer === "core") {
        assert(!specifier.startsWith("node:"), `${path} imports a platform API: ${specifier}`);
        assert(
          specifier.startsWith("./") || specifier.startsWith("../contracts/"),
          `${path} imports a side-effect layer: ${specifier}`,
        );
      }
    }
  }
});

test("named schema export preserves the full catalog and isolates cached output from caller edits", () => {
  const name = "pinata.command.v1";
  const first = exportSchemas(name);
  assert.deepEqual(Object.keys(first), [name]);
  const original = structuredClone(first[name]);
  first[name].type = "null";
  assert.deepEqual(exportSchemas(name)[name], original);
  assert.deepEqual(exportSchemas()[name], original);
  assert.throws(() => exportSchemas("constructor"), /Unknown schema/);
  assert.throws(() => exportSchemas("pinata.missing.v1"), /Unknown schema/);
});
