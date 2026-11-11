import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { ProcessBackend } from "../../engine/backends/process.ts";
import { HerdrBackend, herdrCommandLine } from "../../engine/backends/herdr.ts";
import {
  HerdrCommandError,
  createHerdrControl,
  insideHerdr,
  type HerdrControl,
} from "../../engine/backends/herdr-control.ts";
import { processArtifacts, readCommands } from "../../engine/backends/process-transport.ts";
import {
  assignmentKey,
  canonicalJson,
  definitionSchema,
  digestValue,
  type BackendLaunch,
  type BackendHandle,
  type BackendObservation,
  type CallerAuthority,
  type Grants,
  type ObservationSource,
  type Transition,
  type WorkspacePort,
} from "../../engine/contracts/index.ts";
import { Runtime } from "../../engine/runtime/index.ts";
import { DurableStore } from "../../engine/storage/index.ts";

async function fixture(
  t: TestContext,
  options: { lifetime?: "attached" | "surviving"; task?: string; shell?: boolean } = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-process-backend-")));
  const storeDirectory = join(directory, "run");
  const workspace = join(directory, "workspace");
  const agentDir = join(directory, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(storeDirectory)]);
  const artifacts = processArtifacts(storeDirectory);
  const tools = options.shell ? ["read", "bash"] : ["read"];
  const grants: Grants = {
    access: "read",
    tools,
    workspaces: ["shared"],
    inheritContext: false,
    memory: { scope: "none", access: "read" },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  };
  const definition = await artifacts.put(
    Buffer.from(
      canonicalJson(
        definitionSchema.parse({
          schemaVersion: 1,
          name: "fixture",
          handoffDescription: "Process fixture",
          instructions: "Exercise process transport.",
          tools,
          pinata: { access: "read" },
        }),
      ),
    ),
  );
  const ref = { run: randomUUID(), worker: "worker", assignment: 1 };
  const launch: BackendLaunch = {
    ref,
    attemptId: randomUUID(),
    ownerEpoch: randomUUID(),
    artifacts,
    storeDirectory,
    cwd: workspace,
    worker: {
      id: "worker",
      agent: "fixture",
      definition,
      tools,
      grants,
      access: "read",
      workspace: "shared",
      backend: "process",
      lifetime: options.lifetime ?? "attached",
      depth: 0,
      fallbacks: [],
      model: { provider: "process-fixture", id: "script", thinking: "off" },
    },
    initialMessages: [
      {
        id: "initial",
        target: ref,
        sender: "coordinator",
        kind: "initial",
        text: "first-task-marker",
        state: "recorded",
        attempts: [],
      },
    ],
    brief: { task: options.task ?? "first-task-marker", context: [], dependencies: [] },
  };
  const backend = new ProcessBackend({
    agentDir,
    bootstrapModule: fileURLToPath(
      new URL("./fixtures/rewrite-process-provider.ts", import.meta.url),
    ),
  });
  const observed: Array<{ observation: BackendObservation; source?: ObservationSource }> = [];
  const observe = async (observation: BackendObservation, source?: ObservationSource) => {
    observed.push({ observation, source });
  };
  const handles: Array<Pick<BackendHandle, "stop">> = [];
  const start = async (request = launch) => {
    const handle = await backend.start(request, observe, new AbortController().signal);
    handles.push(handle);
    return handle;
  };
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.stop("Fixture teardown");
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    storeDirectory,
    workspace,
    agentDir,
    launch,
    backend,
    observed,
    observe,
    handles,
    start,
  };
}
const supported = ["linux", "darwin", "win32"].includes(process.platform);

test(
  "replacement process backend retains consumed inputs, usage, transcript and continuation",
  { skip: !supported, timeout: 40_000 },
  async (t) => {
    const world = await fixture(t);
    const first = await world.start();
    const outcome = await first.done;
    assert.equal(outcome.reason, "completed");
    assert.match(outcome.summary, /process-response/);
    assert(outcome.session);
    assert(outcome.transcript);
    assert(
      world.observed.some(
        ({ observation }) =>
          observation.kind === "input_consumed" && observation.messageId === "initial",
      ),
    );
    assert(world.observed.some(({ observation }) => observation.kind === "usage"));
    assert(world.observed.every(({ source }) => source?.sourceId === first.identity.id));
    const stopped = await first.stop("First complete");
    assert.equal(stopped.cleanup.status, "stopped", JSON.stringify(stopped.cleanup));
    const secondRef = { ...world.launch.ref, assignment: 2 };
    const second = await world.start({
      ...world.launch,
      ref: secondRef,
      attemptId: randomUUID(),
      continuation: outcome.session,
      initialMessages: [
        {
          ...world.launch.initialMessages[0],
          id: "follow",
          target: secondRef,
          text: "second-task-marker",
          kind: "follow_up",
        },
      ],
      brief: { task: "second-task-marker", context: [], dependencies: [] },
    });
    assert.equal((await second.done).reason, "completed");
    const turns = await readFile(join(world.agentDir, "turns.jsonl"), "utf8");
    assert.match(turns.split("\n").filter(Boolean).at(-1) ?? "", /first-task-marker/);
    assert.match(turns.split("\n").filter(Boolean).at(-1) ?? "", /second-task-marker/);
    assert.equal((await second.stop("Second complete")).cleanup.status, "stopped");
  },
);

test(
  "replacement process input acknowledgments survive retry and source replay after handoff",
  { skip: !supported, timeout: 40_000 },
  async (t) => {
    const world = await fixture(t, { lifetime: "surviving", task: "slow-steer" });
    const original = await world.start();
    const message = {
      ...world.launch.initialMessages[0],
      id: "steer",
      kind: "steer" as const,
      text: "steer-marker",
    };
    const receipt = await original.input(message);
    assert.deepEqual(await original.input({ ...message, state: "transport_handled" }), receipt);
    const nextEpoch = randomUUID();
    await original.handoff(nextEpoch);
    const replay: typeof world.observed = [];
    const recovered = await world.backend.reattach(
      {
        ref: world.launch.ref,
        attemptId: world.launch.attemptId,
        ownerEpoch: world.launch.ownerEpoch,
        runtimeOwnerEpoch: nextEpoch,
        identity: original.identity,
        storeDirectory: world.storeDirectory,
        artifacts: world.launch.artifacts,
      },
      async (observation, source) => {
        replay.push({ observation, source });
      },
      new AbortController().signal,
    );
    world.handles.push(recovered);
    const result = await recovered.done;
    assert.equal(result.reason, "completed");
    assert(
      replay.some(
        ({ observation }) =>
          observation.kind === "input_consumed" && observation.messageId === "steer",
      ),
    );
    assert(replay.every(({ source }) => source?.sourceId === original.identity.id));
    assert.deepEqual(
      replay.map(({ source }) => source?.ordinal),
      replay.map((_, index) => index + 1),
    );
    assert.deepEqual(await recovered.input(message), receipt);
    const commands = await readCommands(
      join(world.storeDirectory, "workers", digestValue(world.launch.attemptId)),
    );
    assert.equal(commands.filter((entry) => entry.command.action === "input").length, 1);
    const stopped = await recovered.stop("Recovered complete");
    assert.equal(stopped.cleanup.status, "stopped", JSON.stringify(stopped.cleanup));
    assert.equal(stopped.cleanup.ownerEpoch, world.launch.ownerEpoch);
  },
);

test(
  "replacement process cancellation keeps partial outcome and confirms shell descendants",
  { skip: !supported, timeout: 40_000 },
  async (t) => {
    const world = await fixture(t, { task: "cancel" });
    const handle = await world.start();
    await delay(100);
    const stopped = await handle.stop("Cancel fixture");
    assert.equal(stopped.cleanup.status, "stopped", JSON.stringify(stopped.cleanup));
    assert.equal(stopped.outcome?.reason, "cancelled");
    assert(stopped.checkpoint);
    assert.equal((await handle.done).reason, "cancelled");
  },
);

test(
  "replacement process backend supervises actual Pi shell tools",
  { skip: !supported, timeout: 40_000 },
  async (t) => {
    const world = await fixture(t, { task: "shell", shell: true });
    const handle = await world.start();
    assert.equal((await handle.done).reason, "completed");
    const stopped = await handle.stop("Shell complete");
    assert.equal(stopped.cleanup.status, "stopped", JSON.stringify(stopped.cleanup));
    assert.match(await readFile(join(world.agentDir, "turns.jsonl"), "utf8"), /process-shell/);
  },
);

for (const afterCleanup of [false, true])
  test(
    `replacement Runtime recovery ${afterCleanup ? "restores a stopped Pi receipt" : "reattaches a real surviving Pi process"} and settles once`,
    { skip: !supported, timeout: 40_000 },
    async (t) => {
      const world = await fixture(t, { lifetime: "surviving", task: "slow-recover" });
      const caller: CallerAuthority = {
        id: "coordinator",
        kind: "coordinator",
        run: world.launch.ref.run,
        grants: world.launch.worker.grants,
      };
      const runtime = await Runtime.open({
        directory: world.storeDirectory,
        manifest: {
          schemaVersion: 1,
          run: caller.run,
          workspace: world.workspace,
          store: world.storeDirectory,
          createdAt: new Date().toISOString(),
        },
        resolveWorkers: async () => [world.launch.worker],
      });
      assert.equal(
        (
          await runtime.execute(
            {
              requestId: "create",
              command: {
                kind: "create",
                workers: [{ id: "worker", agent: "fixture", task: "slow-recover" }],
              },
            },
            caller,
          )
        ).status,
        "accepted",
      );
      const status = await runtime.query({ kind: "status" }, caller);
      if (status.kind !== "status") throw new Error("Expected status");
      const message = Object.values(status.state.inbox)[0];
      await runtime.close();
      const store = await DurableStore.open({ directory: world.storeDirectory });
      const attemptId = `${assignmentKey(world.launch.ref)}/attempt/1`;
      const ownerEpoch = store.owner.epoch;
      const prepared = {
        identity: "recovery-workspace",
        cwd: world.workspace,
        artifacts: [],
        lease: { id: "recovery-writer", workspace: world.workspace },
      };
      const transitions: Transition[] = [
        { kind: "assignment_state", ref: world.launch.ref, execution: { phase: "preparing" } },
        {
          kind: "attempt_started",
          attempt: {
            id: attemptId,
            ref: world.launch.ref,
            ordinal: 1,
            backend: "process",
            ownerEpoch,
          },
        },
        { kind: "workspace_prepared", attemptId, prepared },
        {
          kind: "effect_intent",
          effect: { id: `${attemptId}/launch`, ref: world.launch.ref, kind: "launch" },
        },
        {
          kind: "inbox_state",
          messageId: message.id,
          state: "dispatch_intent",
          attemptId: `${attemptId}/input/${message.id}`,
        },
      ];
      for (const [index, transition] of transitions.entries())
        await store.append({
          requestId: `seed-${index}`,
          payloadDigest: digestValue(transition),
          transition,
        });
      const handle = await world.backend.start(
        {
          ...world.launch,
          attemptId,
          ownerEpoch,
          initialMessages: [message],
          artifacts: {
            put: (bytes) => store.putArtifact(bytes),
            read: (reference) => store.readArtifact(reference),
          },
        },
        async (observation, source) => {
          if (observation.kind !== "enrolled" || !source) return;
          await store.append({
            requestId: `backend/${JSON.stringify([attemptId, source.sourceId, source.ordinal])}`,
            payloadDigest: digestValue({ source, observation }),
            artifacts: observation.evidence,
            transition: {
              kind: "backend_enrolled",
              attemptId,
              identity: observation.identity,
              evidence: observation.evidence,
            },
          });
        },
        new AbortController().signal,
      );
      if (afterCleanup) {
        await handle.done;
        assert.equal(
          (await handle.stop("Cleanup completed before runtime crash")).cleanup.status,
          "stopped",
        );
      } else await handle.detach();
      await store.close();
      let starts = 0;
      let reattachments = 0;
      let releases = 0;
      const workspace: WorkspacePort = {
        async prepare() {
          throw new Error("Recovery must use its recorded workspace");
        },
        async capture({ cleanup }) {
          assert.equal(cleanup.status, "stopped");
          return { artifacts: [] };
        },
        async release({ cleanup }) {
          assert.equal(cleanup.status, "stopped");
          releases++;
        },
      };
      const reopened = await Runtime.open({
        directory: world.storeDirectory,
        execution: {
          workspace,
          backends: {
            process: {
              kind: "process",
              capabilities: world.backend.capabilities,
              async start(...args) {
                starts++;
                return world.backend.start(...args);
              },
              async reattach(...args) {
                reattachments++;
                return world.backend.reattach(...args);
              },
            },
          },
        },
      });
      t.after(() => reopened.close());
      assert.equal((await reopened.recover({}, caller))[0].status, "reattached");
      const settled = await reopened.wait({}, caller, AbortSignal.timeout(20_000));
      assert.equal(settled.status, "settled", JSON.stringify(reopened.diagnostics()));
      assert.equal(settled.results.length, 1);
      assert.equal(settled.results[0].execution.phase, "ended");
      assert.match(settled.results[0].summary, /process-response/);
      const restored = await reopened.query({ kind: "status" }, caller);
      if (restored.kind !== "status") throw new Error("Expected recovered status");
      assert.equal(restored.state.inbox[message.id].state, "consumed");
      assert.equal(Object.keys(restored.state.attempts).length, 1);
      assert.equal(Object.keys(restored.state.outbox).length, 1);
      assert.equal(restored.state.attempts[attemptId].cleanup?.ownerEpoch, ownerEpoch);
      assert.equal(starts, 0);
      assert.equal(reattachments, 1);
      await reopened.close();
      assert.equal(releases, 1);
    },
  );

test(
  "replacement process backend confirms setup cleanup and refuses mismatched recovery identity",
  { skip: !supported, timeout: 40_000 },
  async (t) => {
    const world = await fixture(t, { lifetime: "surviving", task: "slow" });
    await assert.rejects(
      world.backend.start(
        {
          ...world.launch,
          attemptId: randomUUID(),
          worker: {
            ...world.launch.worker,
            model: { provider: "missing", id: "missing", thinking: "off" },
          },
        },
        world.observe,
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert(error instanceof Error && "cleanup" in error);
        assert.equal(
          (error.cleanup as { status: string }).status,
          "stopped",
          JSON.stringify(error.cleanup),
        );
        return true;
      },
    );
    const handle = await world.start();
    await assert.rejects(
      world.backend.reattach(
        {
          ref: world.launch.ref,
          attemptId: world.launch.attemptId,
          ownerEpoch: world.launch.ownerEpoch,
          runtimeOwnerEpoch: randomUUID(),
          identity: { ...handle.identity, id: "unrelated-worker" },
          storeDirectory: world.storeDirectory,
          artifacts: world.launch.artifacts,
        },
        world.observe,
        new AbortController().signal,
      ),
      /enrollment does not match/,
    );
    assert.equal((await handle.done).reason, "completed");
    assert.equal((await handle.stop("Identity test complete")).cleanup.status, "stopped");
  },
);

test(
  "replacement process cancellation before payload authorization leaves no worker activity",
  { skip: !supported, timeout: 20_000 },
  async (t) => {
    const world = await fixture(t);
    const controller = new AbortController();
    await assert.rejects(
      world.backend.start(
        world.launch,
        async (observation) => {
          if (observation.kind === "enrolled") controller.abort();
        },
        controller.signal,
      ),
      (error: unknown) => {
        assert(error instanceof Error && "cleanup" in error);
        assert.equal((error.cleanup as { status: string }).status, "stopped");
        return true;
      },
    );
    await assert.rejects(readFile(join(world.agentDir, "turns.jsonl")), { code: "ENOENT" });
  },
);

function fakeHerdr(options: { failRun?: boolean } = {}) {
  const calls: string[][] = [];
  const state = { terminal: "owned-terminal", alive: true };
  const control: HerdrControl = {
    receipts: () => [],
    async request(args) {
      calls.push(args);
      const pane = {
        workspace_id: "owned-workspace",
        pane_id: "owned-pane",
        terminal_id: state.terminal,
      };
      if (args[0] === "workspace" && args[1] === "create")
        return { type: "workspace_created", root_pane: pane };
      if (args[1] === "get") {
        if (!state.alive) throw new HerdrCommandError("pane_not_found", "Test pane closed");
        return { pane };
      }
      if (args[1] === "process-info")
        return {
          process_info: {
            shell_pid: 1,
            foreground_process_group_id: 1,
            foreground_processes: [{ pid: 1, name: "/bin/bash" }],
          },
        };
      if (args[1] === "run") {
        if (options.failRun)
          throw new HerdrCommandError("fixture_run_failed", "Monitor failed to start");
        return {};
      }
      if (args[1] === "close") {
        state.alive = false;
        return {};
      }
      throw new Error(`Unexpected fake Herdr command ${args.join(" ")}`);
    },
  };
  return { calls, state, control };
}

function herdrFor(world: Awaited<ReturnType<typeof fixture>>, control?: HerdrControl) {
  return new HerdrBackend({
    agentDir: world.agentDir,
    bootstrapModule: fileURLToPath(
      new URL("./fixtures/rewrite-process-provider.ts", import.meta.url),
    ),
    ...(control ? { control: () => control } : {}),
  });
}

test(
  "replacement Herdr monitor retains pane identity across handoff and never closes a reused pane",
  { skip: !supported, timeout: 40_000 },
  async (t) => {
    const world = await fixture(t, { lifetime: "surviving", task: "slow-herdr" });
    const fake = fakeHerdr();
    const backend = herdrFor(world, fake.control);
    const handle = await backend.start(
      { ...world.launch, worker: { ...world.launch.worker, backend: "herdr-pi" } },
      world.observe,
      new AbortController().signal,
    );
    world.handles.push(handle);
    assert.equal(handle.identity.kind, "herdr-pi");
    assert.equal(handle.mode, "monitor");
    const newEpoch = randomUUID();
    await handle.handoff(newEpoch);
    assert.equal(fake.calls.filter((args) => args[1] === "close").length, 0);
    const recovered = await backend.reattach(
      {
        ref: world.launch.ref,
        attemptId: world.launch.attemptId,
        ownerEpoch: world.launch.ownerEpoch,
        runtimeOwnerEpoch: newEpoch,
        identity: handle.identity,
        storeDirectory: world.storeDirectory,
        artifacts: world.launch.artifacts,
      },
      world.observe,
      new AbortController().signal,
    );
    world.handles.push(recovered);
    assert.equal((await recovered.done).reason, "completed");
    fake.state.terminal = "user-replacement-terminal";
    const stopped = await recovered.stop("Herdr identity fixture complete");
    assert.equal(stopped.cleanup.status, "unconfirmed");
    assert.equal(fake.calls.filter((args) => args[1] === "close").length, 0);
    assert(
      world.observed
        .filter(({ observation }) => observation.kind === "enrolled")
        .every(
          ({ observation }) =>
            observation.kind === "enrolled" && observation.identity.kind === "herdr-pi",
        ),
    );
  },
);

test(
  "replacement Herdr monitor setup failure stops its worker and closes only its owned pane",
  { skip: !supported, timeout: 30_000 },
  async (t) => {
    const world = await fixture(t, { task: "slow-herdr", lifetime: "surviving" });
    const fake = fakeHerdr({ failRun: true });
    const backend = herdrFor(world, fake.control);
    await assert.rejects(
      backend.start(
        { ...world.launch, worker: { ...world.launch.worker, backend: "herdr-pi" } },
        world.observe,
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert(error instanceof Error && "cleanup" in error);
        assert.equal(
          (error.cleanup as { status: string }).status,
          "stopped",
          JSON.stringify(error.cleanup),
        );
        return true;
      },
    );
    assert.deepEqual(
      fake.calls.filter((args) => args[1] === "close"),
      [["pane", "close", "owned-pane"]],
    );
  },
);

test("replacement Herdr command quoting treats shell metacharacters as argument data", () => {
  assert.equal(
    herdrCommandLine(["/a b/node", "literal'$()&"], "posix"),
    "'/a b/node' 'literal'\\''$()&'",
  );
  assert.equal(herdrCommandLine(["a'b", "a\\b"], "fish"), "'a\\'b' 'a\\\\b'");
  assert.equal(herdrCommandLine(["a'b"], "powershell"), "& 'a''b'");
  assert.throws(() => herdrCommandLine(["a\0b"], "posix"), /NUL/);
});

test(
  "replacement Herdr local monitor uses the installed pane API and confirms its own closure",
  { skip: !supported || !insideHerdr(), timeout: 60_000 },
  async (t) => {
    const world = await fixture(t, { task: "slow-herdr", lifetime: "surviving" });
    const backend = herdrFor(world);
    const handle = await backend.start(
      { ...world.launch, worker: { ...world.launch.worker, backend: "herdr-pi" } },
      world.observe,
      new AbortController().signal,
    );
    world.handles.push(handle);
    await handle.detach();
    const recovered = await backend.reattach(
      {
        ref: world.launch.ref,
        attemptId: world.launch.attemptId,
        ownerEpoch: world.launch.ownerEpoch,
        runtimeOwnerEpoch: randomUUID(),
        identity: handle.identity,
        storeDirectory: world.storeDirectory,
        artifacts: world.launch.artifacts,
      },
      world.observe,
      new AbortController().signal,
    );
    world.handles.push(recovered);
    assert.equal((await recovered.done).reason, "completed");
    const saved = JSON.parse(
      await readFile(
        join(world.storeDirectory, "workers", digestValue(world.launch.attemptId), "herdr.json"),
        "utf8",
      ),
    );
    assert.deepEqual(saved.payload.pane, handle.pane);
    const reader = createHerdrControl({
      cwd: world.workspace,
      directory: world.storeDirectory,
      ownerEpoch: world.launch.ownerEpoch,
      artifacts: world.launch.artifacts,
    });
    let visible = "";
    const deadline = performance.now() + 5000;
    while (!visible.includes("process-response")) {
      visible = JSON.stringify(
        await reader.request(
          ["pane", "read", handle.pane.paneId, "--source", "recent-unwrapped", "--lines", "40"],
          AbortSignal.timeout(5000),
        ),
      );
      if (performance.now() >= deadline) break;
      if (!visible.includes("process-response")) await delay(50);
    }
    assert.match(visible, /Pinata worker monitor/);
    assert.match(visible, /process-response/);
    assert(reader.receipts().every((receipt) => receipt.status === "stopped"));
    const stopped = await recovered.stop("Local Herdr monitor fixture complete");
    assert.equal(stopped.cleanup.status, "stopped", JSON.stringify(stopped.cleanup));
  },
);

test(
  "replacement Herdr recovery restores terminal receipts after its own pane has closed",
  { skip: !supported, timeout: 30_000 },
  async (t) => {
    const world = await fixture(t);
    const fake = fakeHerdr();
    const backend = herdrFor(world, fake.control);
    const handle = await backend.start(
      { ...world.launch, worker: { ...world.launch.worker, backend: "herdr-pi" } },
      world.observe,
      new AbortController().signal,
    );
    world.handles.push(handle);
    const outcome = await handle.done;
    assert.equal(
      (await handle.stop("Herdr cleanup before journal settlement")).cleanup.status,
      "stopped",
    );
    assert.equal(fake.state.alive, false);
    const commandsBefore = await readCommands(
      join(world.storeDirectory, "workers", digestValue(world.launch.attemptId)),
    );
    const recovered = await backend.reattach(
      {
        ref: world.launch.ref,
        attemptId: world.launch.attemptId,
        ownerEpoch: world.launch.ownerEpoch,
        runtimeOwnerEpoch: randomUUID(),
        identity: handle.identity,
        storeDirectory: world.storeDirectory,
        artifacts: world.launch.artifacts,
      },
      world.observe,
      new AbortController().signal,
    );
    world.handles.push(recovered);
    assert.equal((await recovered.done).summary, outcome.summary);
    assert.equal(
      (await recovered.stop("Confirm retained terminal receipt")).cleanup.status,
      "stopped",
    );
    assert.deepEqual(await recovered.input({ ...world.launch.initialMessages[0], id: "late" }), {
      status: "undelivered",
    });
    assert.deepEqual(
      await readCommands(
        join(world.storeDirectory, "workers", digestValue(world.launch.attemptId)),
      ),
      commandsBefore,
    );
    assert.equal(fake.calls.filter((args) => args[1] === "run").length, 1);
    assert.equal(fake.calls.filter((args) => args[1] === "close").length, 1);
  },
);

test(
  "replacement process recovery refuses a schema-valid corrupted durable stop receipt",
  { skip: !supported, timeout: 30_000 },
  async (t) => {
    const world = await fixture(t);
    const handle = await world.start();
    await handle.done;
    assert.equal((await handle.stop("Retain completed worker receipt")).cleanup.status, "stopped");
    const directory = join(world.storeDirectory, "workers", digestValue(world.launch.attemptId));
    const commands = await readCommands(directory);
    const stop = commands.find((entry) => entry.id === "stop");
    assert(stop);
    const path = join(directory, "responses", `${String(stop.ordinal).padStart(16, "0")}.json`);
    const original = await readFile(path, "utf8");
    const corrupted = JSON.parse(original);
    corrupted.payload.stopped.cleanup.ownerEpoch = "different-owner";
    await writeFile(path, JSON.stringify(corrupted));
    await assert.rejects(
      world.backend.reattach(
        {
          ref: world.launch.ref,
          attemptId: world.launch.attemptId,
          ownerEpoch: world.launch.ownerEpoch,
          runtimeOwnerEpoch: randomUUID(),
          identity: handle.identity,
          storeDirectory: world.storeDirectory,
          artifacts: world.launch.artifacts,
        },
        world.observe,
        new AbortController().signal,
      ),
      /digest does not match/,
    );
    await writeFile(path, original);
  },
);
