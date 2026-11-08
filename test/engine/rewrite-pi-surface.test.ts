import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPinataExtension } from "../../rewrite/engine/pi/extension.ts";
import { invokeCoordinatorTool } from "../../rewrite/engine/pi/tools.ts";
import { completionMessageType, noticeId } from "../../rewrite/engine/pi/notifications.ts";
import { parseMention, routeMention } from "../../rewrite/engine/pi/mentions.ts";
import { openHost, type Host } from "../../rewrite/engine/host/index.ts";
import { surfaceReplySchema, type AssignmentRef } from "../../rewrite/engine/contracts/index.ts";
import { surfaceFixture } from "./rewrite-surface-fixture.ts";

async function fixture(
  t: TestContext,
  options: { recorded?: boolean; dropCompletion?: () => boolean | "marker" } = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-pi-surface-")));
  const workspace = join(directory, "workspace");
  const agentDir = join(directory, "pi");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({
    provider: "coordinator-fixture",
    models: [{ id: "script", contextWindow: 200_000, maxTokens: 4096 }],
  });
  faux.setResponses(
    Array.from({ length: 20 }, () => async (context, options, _state, model) => {
      // The native faux provider does not issue HTTP and does not call this
      // public hook itself. Exercise Pi's provider-boundary callback explicitly.
      await options?.onPayload?.({ messages: context.messages }, model);
      return fauxAssistantMessage("@scout model-output-is-data");
    }),
  );
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const hosts: Host[] = [];
  const navigation: Array<AssignmentRef | undefined> = [];
  const settings = SettingsManager.inMemory({
    cacheWarming: "off",
    compaction: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp"],
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      createPinataExtension({
        host: {
          workspace,
          directory: join(directory, "run"),
          agentDir,
          modelRuntime,
          config: { run: { codemode: false } },
          parentModel: { provider: "coordinator-fixture", id: "script", thinking: "off" },
        },
        open: async (options) => {
          const host = await openHost(options);
          hosts.push(host);
          return host;
        },
        navigate: async (_context, _host, ref) => {
          navigation.push(ref);
        },
      }),
      (pi) => {
        pi.on("context", (event) => {
          const drop = options.dropCompletion?.();
          if (!drop) return;
          return {
            messages: event.messages.flatMap((message) => {
              if (message.role !== "custom" || message.customType !== completionMessageType)
                return [message];
              if (drop !== "marker") return [];
              return [
                {
                  ...message,
                  content:
                    typeof message.content === "string"
                      ? (message.content.split("\n").at(-1) ?? "")
                      : "",
                },
              ];
            }),
          };
        });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.create(workspace, join(directory, "sessions"));
  if (options.recorded !== false)
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Existing coordinator conversation" }],
      timestamp: Date.now(),
    });
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    sessionManager: manager,
    resourceLoader: loader,
    settingsManager: settings,
    tools: [],
  });
  const notices: string[] = [];
  let draft = "";
  const errors: string[] = [];
  await session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      setEditorText: (text) => {
        draft = text;
      },
      getEditorText: () => draft,
      notify: (message, kind) => {
        notices.push(message);
        if (kind === "error") errors.push(message);
      },
    },
    onError: (error) => errors.push(error.error),
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    for (const host of hosts) await host.close("Fixture teardown");
    await rm(directory, { recursive: true, force: true });
  });
  return { session, manager, faux, hosts, navigation, notices, errors, draft: () => draft };
}

test("mention grammar ignores embedded handles, quoted text, emails and path fragments", () => {
  for (const input of [
    "mail a@host.test",
    "@mail@host.test",
    "see @scout now",
    "`@scout code`",
    '"@scout quoted"',
    "./@scout/file",
    "    @scout code",
    "@scout!",
    "@UPPER task",
  ])
    assert.equal(parseMention(input), undefined, input);
  assert.deepEqual(parseMention("@scout task\ncontinued"), {
    handle: "scout",
    text: "task\ncontinued",
  });
  assert.deepEqual(parseMention("@run-one/scout"), { run: "run-one", handle: "scout", text: "" });
});

test(
  "canonical Pi tool mappings match direct Runtime and authenticated IPC receipts",
  { timeout: 15_000 },
  async (t) => {
    const f = await surfaceFixture(t);
    const client = await f.connect();
    const value = {
      requestId: "shared-request",
      command: { kind: "create", workers: [{ id: "worker", agent: "fixture", task: "first" }] },
    };
    const reply = await invokeCoordinatorTool("pinata_run", value, "call", f.control);
    const direct = await f.runtime.execute(value, f.caller);
    const ipc = await client.request({ method: "execute", input: value });
    assert.deepEqual(reply, { status: "ok", response: { method: "execute", result: direct } });
    assert.deepEqual(ipc, reply);
    const invalid = {
      requestId: "invalid",
      command: {
        kind: "add",
        workers: [
          {
            id: "later",
            agent: "fixture",
            task: "next",
            after: [{ run: f.run, worker: "worker", assignment: 999 }],
          },
        ],
      },
    };
    const rejected = await invokeCoordinatorTool("pinata_run", invalid, "call-2", f.control);
    assert.deepEqual(rejected, await f.control.request({ method: "execute", input: invalid }));
    assert.equal(
      (await invokeCoordinatorTool("pinata_run", { workers: [] }, "bad", f.control)).status,
      "error",
    );
  },
);

test(
  "real Pi input routes handles without coordinator turns and deduplicates saved completion notices",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await f.session.prompt("@scout");
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(f.navigation.length, 1, JSON.stringify(f.errors));
    const host = f.hosts[0];
    assert(host);
    const delivered = (count: number): Promise<void> =>
      new Promise((resolve) => {
        let unsubscribe = (): void => {};
        unsubscribe = host.runtime.subscribe({}, host.caller, () => {
          if (
            Object.values(host.source.snapshot().snapshot.outbox).filter(
              (notice) => notice.state === "delivered" || notice.state === "consumed",
            ).length >= count
          ) {
            unsubscribe();
            resolve();
          }
        });
        t.after(unsubscribe);
      });
    assert.equal(Object.keys(host.source.snapshot().snapshot.workers).length, 0);
    await f.session.prompt("@missing keep this draft");
    assert.equal(f.draft(), "@missing keep this draft");
    assert.equal(f.faux.state.callCount, 0);
    f.errors.length = 0;
    await f.session.prompt("@scout first assignment");
    assert.equal(f.draft(), "");
    const first = await host.runtime.wait({}, host.caller, AbortSignal.timeout(15_000));
    assert.equal(first.results[0]?.ref.assignment, 1, JSON.stringify(f.errors));
    assert.equal(f.faux.state.callCount, 1, "Only the worker requested a provider response");
    await host.runtime.deliverNotifications(host.caller);
    await host.runtime.deliverNotifications(host.caller);
    await delivered(1);
    assert.equal(f.manager.getEntries().filter((entry) => noticeId(entry)).length, 1);
    const state = host.source.snapshot().snapshot;
    const id = Object.keys(state.outbox)[0];
    assert.equal(state.outbox[id].state, "delivered");
    const tool = f.session.extensionRunner.getToolDefinition("pinata_status");
    assert(tool);
    const status = await tool.execute(
      "status-call",
      {},
      undefined,
      undefined,
      f.session.extensionRunner.createToolContext("status-call", undefined),
    );
    const statusReply = surfaceReplySchema.parse(status.details);
    assert.equal(statusReply.status, "ok");
    await f.session.prompt("@scout second assignment");
    const second = await host.runtime.wait({}, host.caller, AbortSignal.timeout(15_000));
    assert.equal(second.results[0]?.ref.assignment, 2);
    await host.runtime.deliverNotifications(host.caller);
    await delivered(2);
    assert.equal(f.manager.getEntries().filter((entry) => noticeId(entry)).length, 2);
    await f.session.prompt("ordinary parent message");
    assert.equal(f.faux.state.callCount, 3);
    assert.equal(
      host.source.snapshot().snapshot.latest.scout,
      2,
      "Model output was never routed as a command",
    );
    assert(
      Object.values(host.source.snapshot().snapshot.outbox).every(
        (notice) => notice.state === "consumed",
      ),
      JSON.stringify({ errors: f.errors, outbox: host.source.snapshot().snapshot.outbox }),
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  "a first-message completion stays uncertain until Pi persists or consumes its parent branch",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, { recorded: false });
    await f.session.prompt("@scout first assignment");
    const host = f.hosts[0];
    assert(host, JSON.stringify(f.errors));
    const waited = await host.runtime.wait({}, host.caller, AbortSignal.timeout(10_000));
    assert.equal(waited.status, "settled");
    assert.equal(f.faux.state.callCount, 1, "Only the worker invoked its scripted provider");
    await host.runtime.deliverNotifications(host.caller);
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Completion did not retain uncertain delivery"));
      }, 5000);
      let unsubscribe = (): void => {};
      const inspect = () => {
        if (
          Object.values(host.source.snapshot().snapshot.outbox).some(
            (notice) => notice.state === "uncertain",
          )
        ) {
          clearTimeout(timer);
          unsubscribe();
          done();
        }
      };
      unsubscribe = host.runtime.subscribe({}, host.caller, inspect);
      inspect();
      t.after(() => {
        clearTimeout(timer);
        unsubscribe();
      });
    });
    assert.equal(f.manager.getEntries().filter((entry) => noticeId(entry)).length, 1);
    const path = f.manager.getSessionFile();
    assert(path);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    await host.runtime.deliverNotifications(host.caller);
    assert.equal(
      f.manager.getEntries().filter((entry) => noticeId(entry)).length,
      1,
      "An uncertain retry does not duplicate the in-memory notice",
    );
    await f.session.prompt("Persist this parent conversation");
    assert.equal(f.faux.state.callCount, 2);
    assert((await readFile(path, "utf8")).includes("pinata.completion.v3"));
    assert(
      Object.values(host.source.snapshot().snapshot.outbox).every(
        (notice) => notice.state === "consumed",
      ),
      JSON.stringify({ errors: f.errors, outbox: host.source.snapshot().snapshot.outbox }),
    );
    await host.runtime.deliverNotifications(host.caller);
    assert.equal(f.manager.getEntries().filter((entry) => noticeId(entry)).length, 1);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "a saved notice is not consumed when another context extension removes it from the provider payload",
  { timeout: 20_000 },
  async (t) => {
    let dropCompletion: boolean | "marker" = true;
    const f = await fixture(t, { dropCompletion: () => dropCompletion });
    await f.session.prompt("@scout first assignment");
    const host = f.hosts[0];
    assert(host, JSON.stringify(f.errors));
    await host.runtime.wait({}, host.caller, AbortSignal.timeout(10_000));
    await host.runtime.deliverNotifications(host.caller);
    await new Promise<void>((done, reject) => {
      let unsubscribe = (): void => {};
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Completion notice was not delivered"));
      }, 5000);
      const inspect = () => {
        if (
          !Object.values(host.source.snapshot().snapshot.outbox).some(
            (notice) => notice.state === "delivered",
          )
        )
          return;
        clearTimeout(timer);
        unsubscribe();
        done();
      };
      unsubscribe = host.runtime.subscribe({}, host.caller, inspect);
      inspect();
      t.after(() => {
        clearTimeout(timer);
        unsubscribe();
      });
    });
    assert.equal(f.manager.getEntries().filter((entry) => noticeId(entry)).length, 1);
    await f.session.prompt("Parent request without the completion notice");
    assert(
      Object.values(host.source.snapshot().snapshot.outbox).every(
        (notice) => notice.state !== "consumed",
      ),
      "Branch membership alone does not prove provider-boundary consumption",
    );
    dropCompletion = "marker";
    await f.session.prompt("Parent request retaining only the notice marker");
    assert(
      Object.values(host.source.snapshot().snapshot.outbox).every(
        (notice) => notice.state !== "consumed",
      ),
      "The marker alone does not attest consumption of the saved notice content",
    );
    dropCompletion = false;
    await f.session.prompt("Parent request including the completion notice");
    assert(
      Object.values(host.source.snapshot().snapshot.outbox).every(
        (notice) => notice.state === "consumed",
      ),
      JSON.stringify({ errors: f.errors, outbox: host.source.snapshot().snapshot.outbox }),
    );
    assert.deepEqual(f.errors, []);
  },
);

test(
  "cross-run handles require an explicit selector and existing workers win over definitions",
  { timeout: 15_000 },
  async (t) => {
    const left = await surfaceFixture(t);
    const right = await surfaceFixture(t);
    for (const f of [left, right])
      await f.runtime.execute(
        {
          requestId: "create",
          command: { kind: "create", workers: [{ id: "scout", agent: "fixture", task: "start" }] },
        },
        f.caller,
      );
    const ambiguous = await routeMention(
      "@scout instruction",
      [left.control, right.control],
      left.control,
    );
    assert.equal(ambiguous.kind, "error");
    const directed = await routeMention(
      `@${right.run}/scout instruction`,
      [left.control, right.control],
      left.control,
    );
    assert.equal(directed.kind, "receipt");
    if (directed.kind !== "receipt") throw new Error("Missing receipt");
    assert.equal(directed.receipt.status, "accepted");
    assert.equal(Object.values(right.control.snapshot().snapshot.inbox).length, 2);
    assert.equal(Object.values(left.control.snapshot().snapshot.inbox).length, 1);
  },
);
