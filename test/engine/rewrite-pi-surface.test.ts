import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
  type InputEvent,
} from "@earendil-works/pi-coding-agent";
import { createPinataExtension } from "../../engine/pi/extension.ts";
import { invokeCoordinatorTool } from "../../engine/pi/tools.ts";
import { completionMessageType, noticeId } from "../../engine/pi/notifications.ts";
import { parseMention, routeMention } from "../../engine/pi/mentions.ts";
import { readMentionIntent } from "../../engine/pi/mention-input.ts";
import { openHost, type Host } from "../../engine/host/index.ts";
import {
  surfaceReplySchema,
  toolPageSchema,
  type AssignmentRef,
  type Grants,
} from "../../engine/contracts/index.ts";
import { toolContentBytes } from "../../engine/sources/pages.ts";
import { MemoryStore } from "../../engine/memory/index.ts";
import { surfaceFixture } from "./rewrite-surface-fixture.ts";

async function fixture(
  t: TestContext,
  options: {
    recorded?: boolean;
    dropCompletion?: () => boolean | "marker";
    grants?: Grants;
    run?: string;
  } = {},
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
          grants: options.grants,
          run: options.run,
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
  const inputHandler = loader
    .getExtensions()
    .extensions.flatMap((extension) => extension.handlers.get("input") ?? [])[0];
  assert(inputHandler);
  return {
    session,
    manager,
    faux,
    hosts,
    navigation,
    notices,
    errors,
    inputHandler,
    draft: () => draft,
  };
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
    "@run-one/scout task",
    "@scout.md task",
  ])
    assert.equal(parseMention(input), undefined, input);
  assert.deepEqual(parseMention("@scout task\ncontinued"), {
    handle: "scout",
    text: "task\ncontinued",
  });
  assert.deepEqual(parseMention("@run-one:scout"), { run: "run-one", handle: "scout", text: "" });
});

test(
  "addressed input callback repeats and explicit uncertain retries preserve the exact durable command",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, { recorded: false, run: " team: one " });
    const context = f.session.extensionRunner.createContext();
    const event: InputEvent = {
      type: "input",
      text: "@scout repeated text",
      source: "interactive",
    };
    const outcomes = await Promise.all([
      f.inputHandler(event, context),
      f.inputHandler(event, context),
    ]);
    assert.deepEqual(outcomes, [{ action: "handled" }, { action: "handled" }]);
    const host = f.hosts[0];
    assert(host);
    await host.runtime.wait({}, host.caller, AbortSignal.timeout(15_000));
    await f.inputHandler(event, context);
    assert.equal(host.source.snapshot().snapshot.latest.scout, 1);
    const entries = () =>
      f.manager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "pinata.input.v3");
    assert.equal(entries().length, 1);
    const firstFiles = await readdir(join(host.directory, "mention-inputs"));
    assert.equal(firstFiles.length, 1);
    const token = firstFiles[0].replace(/\.json$/, "");
    const first = await readMentionIntent(host.directory, token, {
      run: host.caller.run,
      session: f.manager.getSessionId(),
    });
    assert.equal(first.entry, entries()[0].id);
    assert.equal(first.envelope.command.kind, "create");
    await assert.rejects(
      readMentionIntent(host.directory, token, {
        run: host.caller.run,
        session: "different-session",
      }),
      /another session or run/,
    );
    // Pi has not persisted a custom-only first session, but its addressed intent is durable.
    const sessionFile = f.manager.getSessionFile();
    assert(sessionFile);
    await assert.rejects(readFile(sessionFile), { code: "ENOENT" });
    await f.session.prompt(`/pinata-retry ${token}`);
    assert.equal(host.source.snapshot().snapshot.latest.scout, 1);

    // A new event carrying identical text is a new intentional input.
    await f.inputHandler({ ...event }, context);
    await host.runtime.wait({}, host.caller, AbortSignal.timeout(15_000));
    assert.equal(host.source.snapshot().snapshot.latest.scout, 2);
    assert.equal(entries().length, 2);

    const request = host.source.request.bind(host.source);
    let lost = false;
    host.source.request = async (call, signal) => {
      const response = await request(call, signal);
      if (!lost && response.status === "ok" && response.response.method === "execute") {
        lost = true;
        throw new Error("Simulated lost receipt after durable acceptance");
      }
      return response;
    };
    f.session.extensionRunner.getUIContext().setEditorText("a newer user draft");
    await f.inputHandler({ ...event, text: "@scout uncertain follow-up" }, context);
    host.source.request = request;
    assert(lost);
    assert.equal(f.draft(), "a newer user draft");
    const retry = f.errors
      .find((message) => message.includes("/pinata-retry"))
      ?.match(/\/pinata-retry (?:"(?:\\.|[^"])*"|[A-Za-z0-9._-]+):[a-f0-9]{64}/)?.[0];
    assert(retry, JSON.stringify(f.errors));
    f.errors.length = 0;
    await host.runtime.wait({}, host.caller, AbortSignal.timeout(15_000));
    await f.session.prompt(retry);
    assert.equal(host.source.snapshot().snapshot.latest.scout, 3);
    assert.equal(f.draft(), "a newer user draft");
    assert.equal(Object.keys(host.source.snapshot().snapshot.inbox).length, 3);
    assert.equal(
      f.faux.state.callCount,
      3,
      "Only the three workers' assignments call the provider",
    );
    assert.equal(f.errors.length, 0);

    let commitUnknown = false;
    host.source.request = async (call, signal) => {
      const response = await request(call, signal);
      if (!commitUnknown && response.status === "ok" && response.response.method === "execute") {
        commitUnknown = true;
        const receipt = response.response.result;
        return {
          status: "ok",
          response: {
            method: "execute",
            result: {
              status: "rejected",
              requestId: receipt.requestId,
              revision: receipt.revision,
              error: { code: "commit_unknown", message: "Commit acknowledgment is uncertain" },
            },
          },
        };
      }
      return response;
    };
    await f.inputHandler({ ...event, text: "@scout uncertain commit" }, context);
    host.source.request = request;
    assert(commitUnknown);
    const commitRetry = f.errors
      .find((message) => message.includes("/pinata-retry"))
      ?.match(/\/pinata-retry (?:"(?:\\.|[^"])*"|[A-Za-z0-9._-]+):[a-f0-9]{64}/)?.[0];
    assert(commitRetry, JSON.stringify(f.errors));
    f.errors.length = 0;
    await host.runtime.wait({}, host.caller, AbortSignal.timeout(15_000));
    await f.session.prompt(commitRetry);
    assert.equal(host.source.snapshot().snapshot.latest.scout, 4);
    assert.equal(Object.keys(host.source.snapshot().snapshot.inbox).length, 4);
    assert.equal(f.faux.state.callCount, 4);
    assert.deepEqual(f.errors, []);

    const path = join(host.directory, "mention-inputs", `${token}.json`);
    await writeFile(path, `${await readFile(path, "utf8")} `);
    await f.session.prompt(`/pinata-retry ${token}`);
    assert.match(f.errors.pop() ?? "", /integrity check/);
    assert.equal(host.source.snapshot().snapshot.latest.scout, 4);
  },
);

test(
  "Pi memory commands inspect, edit and clear frozen scopes with CAS and no model turn",
  { timeout: 30_000 },
  async (t) => {
    const grants: Grants = {
      access: "read",
      tools: ["read", "grep", "find", "ls"],
      workspaces: ["shared"],
      inheritContext: false,
      memory: { scope: "project-agent", access: "write" },
      delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
    };
    const f = await fixture(t, { grants });
    await f.session.prompt("/pinata-memory inspect missing");
    assert.match(f.errors.pop() ?? "", /No worker missing/);
    const host = f.hosts[0];
    assert(host);
    const created = await host.runtime.execute(
      {
        requestId: "memory-workers",
        command: {
          kind: "create",
          workers: [
            {
              id: "writer",
              agent: "scout",
              task: "memory writer",
              memory: { scope: "project-agent", access: "write" },
            },
            {
              id: "reader",
              agent: "scout",
              task: "memory reader",
              memory: { scope: "project-agent", access: "read" },
            },
            { id: "absent", agent: "scout", task: "no memory" },
          ],
        },
      },
      host.caller,
    );
    assert.equal(created.status, "accepted", JSON.stringify(created));
    assert.equal(
      (await host.runtime.wait({}, host.caller, AbortSignal.timeout(20_000))).status,
      "settled",
    );
    const workers = structuredClone(host.source.snapshot().snapshot.workers);
    const store = await MemoryStore.open({
      project: host.workspace,
      run: host.caller.run,
      worker: workers.writer,
    });
    const calls = f.faux.state.callCount;
    const displayed = () =>
      f.manager.getEntries().flatMap((entry) => {
        if (entry.type !== "custom_message" || entry.customType !== "pinata.memory.v3") return [];
        assert.equal(typeof entry.content, "string");
        return [JSON.parse(String(entry.content))];
      });
    f.session.extensionRunner.getUIContext().setEditorText("");
    await f.session.prompt("/pinata-memory inspect writer");
    assert.equal(
      displayed().at(-1)?.revision,
      0,
      JSON.stringify({ errors: f.errors, entries: displayed() }),
    );
    assert.equal(displayed().at(-1)?.value, null);
    await assert.rejects(readFile(join(store.directory, "head.json")), { code: "ENOENT" });

    const input = { expectedRevision: 0, text: "retained\nUnicode 🪅", data: { checked: true } };
    await f.session.prompt(`/pinata-memory edit writer ${JSON.stringify(input)}`);
    assert.equal(displayed().at(-1)?.revision, 1);
    assert.deepEqual((await store.read()).value, { text: input.text, data: input.data });
    await f.session.prompt("/pinata-memory inspect reader");
    assert.equal(displayed().at(-1)?.revision, 1);

    const conflict = `/pinata-memory edit writer ${JSON.stringify({ ...input, text: "stale" })}`;
    await f.session.prompt(conflict);
    assert.match(f.errors.pop() ?? "", /expected 0, found 1/);
    assert.equal(f.draft(), conflict);
    assert.equal((await store.read()).revision, 1);
    f.session.extensionRunner.getUIContext().setEditorText("a newer user draft");
    await f.session.prompt("/pinata-memory clear writer 0");
    assert.match(f.errors.pop() ?? "", /expected 0, found 1/);
    assert.equal(f.draft(), "a newer user draft");

    await f.session.prompt(`/pinata-grants ${JSON.stringify(grants)}`);
    await f.session.prompt(
      `/pinata-memory edit reader ${JSON.stringify({ expectedRevision: 1, text: "ungranted" })}`,
    );
    assert.match(f.errors.pop() ?? "", /explicit scoped memory write grant/);
    await f.session.prompt("/pinata-memory clear reader 1");
    assert.match(f.errors.pop() ?? "", /explicit scoped memory write grant/);
    await f.session.prompt("/pinata-memory inspect absent");
    assert.match(f.errors.pop() ?? "", /no retained-memory grant/);
    await f.session.prompt("/pinata-memory clear writer 1");
    assert.equal(displayed().at(-1)?.revision, 2);
    assert.equal(displayed().at(-1)?.value, null);
    assert.deepEqual(
      (await store.history()).map(({ revision, value }) => ({ revision, value })),
      [
        { revision: 2, value: null },
        { revision: 1, value: { text: input.text, data: input.data } },
      ],
    );
    assert.deepEqual(host.source.snapshot().snapshot.workers, workers);
    assert.equal(f.faux.state.callCount, calls);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "Pi tools bound model-facing status while retaining exact details and immutable read-only pages",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const statusTool = f.session.extensionRunner.getToolDefinition("pinata_status");
    const pageTool = f.session.extensionRunner.getToolDefinition("pinata_page");
    assert(statusTool && pageTool);
    const context = f.session.extensionRunner.createToolContext("paged-status", undefined);
    await statusTool.execute("open-host", {}, undefined, undefined, context);
    const host = f.hosts[0];
    assert(host);
    const receipt = await host.runtime.execute(
      {
        requestId: "large-task",
        command: {
          kind: "create",
          workers: [{ id: "large", agent: "scout", task: "large task context ".repeat(6000) }],
        },
      },
      host.caller,
    );
    assert.equal(receipt.status, "accepted");
    await host.runtime.wait({}, host.caller, AbortSignal.timeout(20_000));
    const output = await statusTool.execute("paged-status", {}, undefined, undefined, context);
    const original = surfaceReplySchema.parse(output.details);
    assert(
      original.status === "ok" &&
        original.response.method === "query" &&
        original.response.result.kind === "status",
    );
    const text = output.content.find((part) => part.type === "text");
    assert(text?.type === "text");
    assert(Buffer.byteLength(text.text) <= toolContentBytes);
    let page = toolPageSchema.parse(JSON.parse(text.text));
    let retained = page.text;
    // The next read must keep the first immutable reply after live state changes.
    await host.runtime.execute(
      {
        requestId: "later-task",
        command: {
          kind: "add",
          workers: [{ id: "later", agent: "scout", task: "later accepted work" }],
        },
      },
      host.caller,
    );
    while (!page.complete) {
      assert(page.nextCursor);
      const response = await pageTool.execute(
        "read-page",
        { cursor: page.nextCursor },
        undefined,
        undefined,
        context,
      );
      const content = response.content.find((part) => part.type === "text");
      assert(content?.type === "text");
      assert(Buffer.byteLength(content.text) <= toolContentBytes);
      page = toolPageSchema.parse(response.details);
      retained += page.text;
    }
    assert.deepEqual(JSON.parse(retained), original);
    assert.deepEqual(Object.keys(original.response.result.state.workers), ["large"]);
    assert.equal(Object.keys(host.source.snapshot().snapshot.workers).length, 2);
  },
);

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
    f.session.extensionRunner.getUIContext().setEditorText("");
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
  "handles prefer the selected run, otherwise require a unique worker or run prefix",
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
    const selected = await routeMention(
      "@scout instruction",
      [left.control, right.control],
      left.control,
    );
    assert.equal(selected.kind, "receipt");
    const directed = await routeMention(
      `@${right.run.slice(0, 12)}:scout instruction`,
      [left.control, right.control],
      left.control,
    );
    assert.equal(directed.kind, "receipt");
    if (directed.kind !== "receipt") throw new Error("Missing receipt");
    assert.equal(directed.receipt.status, "accepted");
    assert.equal(Object.values(right.control.snapshot().snapshot.inbox).length, 2);
    assert.equal(Object.values(left.control.snapshot().snapshot.inbox).length, 2);
    const empty = await surfaceFixture(t);
    const ambiguous = await routeMention(
      "@scout instruction",
      [left.control, right.control, empty.control],
      empty.control,
    );
    assert.equal(ambiguous.kind, "error");
    if (ambiguous.kind !== "error") throw new Error("Missing ambiguity result");
    assert(ambiguous.message.includes(left.run) && ambiguous.message.includes(right.run));
    const unique = await routeMention(
      "@scout instruction",
      [right.control, empty.control],
      empty.control,
    );
    assert.equal(unique.kind, "receipt");
    const prefix = left.run.slice(0, 1);
    const collision = { ...right.control, run: `${prefix}another-run` };
    const refused = await routeMention(
      `@${prefix}:scout instruction`,
      [left.control, collision],
      empty.control,
    );
    assert.equal(refused.kind, "error");
    const longer = { ...right.control, run: `${left.run}-longer` };
    const exact = await routeMention(
      `@${left.run}:scout instruction`,
      [left.control, longer],
      empty.control,
    );
    assert.equal(exact.kind, "receipt");
    if (exact.kind !== "receipt") throw new Error("Missing exact-run receipt");
    assert.equal(exact.source, left.control);
  },
);

test("compact discovery exposes launch grants while preserving full definitions and schema details", async (t) => {
  const f = await fixture(t);
  const agents = f.session.extensionRunner.getToolDefinition("pinata_agents");
  const status = f.session.extensionRunner.getToolDefinition("pinata_status");
  assert(agents && status);
  const context = f.session.extensionRunner.createToolContext("discovery", undefined);
  const result = await agents.execute("agents", {}, undefined, undefined, context);
  const text = result.content.find((part) => part.type === "text");
  assert(text?.type === "text");
  const compact = JSON.parse(text.text);
  assert.equal(compact.kind, "agents");
  assert.equal(compact.launch.grants.inheritContext, false);
  assert.equal(compact.delegation.enabled, false);
  assert.deepEqual(compact.delegation.parents, []);
  assert(
    compact.agents.every(
      (agent: { handoffs: string[]; delegation: { enabled: boolean } }) =>
        Array.isArray(agent.handoffs) && !agent.delegation.enabled,
    ),
  );
  assert(compact.launch.backends["in-process"]);
  assert(!compact.agents[0].instructions);
  const detail = surfaceReplySchema.parse(result.details);
  assert.equal(detail.status, "ok");
  if (
    detail.status !== "ok" ||
    detail.response.method !== "query" ||
    detail.response.result.kind !== "definitions"
  )
    throw new Error("Expected definitions");
  assert(detail.response.result.definitions[0].definition.instructions);
  const schemas = await status.execute(
    "schemas",
    { query: { kind: "schemas" } },
    undefined,
    undefined,
    context,
  );
  const schemaText = schemas.content.find((part) => part.type === "text");
  assert(schemaText?.type === "text");
  const index = JSON.parse(schemaText.text);
  assert.equal(index.kind, "schema_index");
  assert(index.names.includes("pinata.command.v1"));
  assert.equal(surfaceReplySchema.parse(schemas.details).status, "ok");
});
