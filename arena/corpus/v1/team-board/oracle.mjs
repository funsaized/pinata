import assert from "node:assert/strict";
import { runOracle } from "../../oracle-harness.mjs";
import { openBrowser } from "../../browser.mjs";
const empty = { nextId: 1, tickets: [], requests: [] };
const draft = { title: "Ship release", assignee: "Ada", status: "todo", priority: 2 };
const ticket = { id: "t1", ...draft, revision: 1 };
const populated = { nextId: 2, tickets: [ticket], requests: [] };
const request = async (base, path, method = "GET", body, headers = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
};
async function withServer(modules, check) {
  const started = await modules.server.startServer({ port: 0 });
  assert.ok(Number.isInteger(started.port) && started.port > 0 && started.port < 65536);
  try {
    return await check(`http://127.0.0.1:${started.port}`);
  } finally {
    await modules.server.stopServer();
  }
}
async function withBrowser(modules, check) {
  return withServer(modules, async (base) => {
    const browser = await openBrowser(base);
    try {
      await browser.waitFor('document.querySelector("[data-empty]") !== null');
      return await check(browser, base);
    } finally {
      await browser.close();
    }
  });
}
const submit = (title) =>
  `document.querySelector('[name="title"]').value=${JSON.stringify(title)};document.querySelector('[name="assignee"]').value='Ada';document.querySelector('#ticket-form').requestSubmit();`;
await runOracle(
  process.argv[2],
  [
    "validation",
    "query",
    "storage",
    "store",
    "api",
    "html",
    "view",
    "styles",
    "page",
    "api-client",
    "client",
    "server",
  ],
  [
    [
      "draft normalization trims and applies defaults",
      async ({ validation }) =>
        assert.deepEqual(await validation.normalizeDraft({ title: "  Hello  ", extra: 1 }), {
          title: "Hello",
          assignee: "",
          status: "todo",
          priority: 1,
        }),
    ],
    [
      "draft validation rejects invalid fields",
      async ({ validation }) => {
        for (const value of [
          null,
          [],
          { title: " " },
          { title: "x".repeat(101) },
          { title: "x", assignee: null },
          { title: "x", status: "TODO" },
          { title: "x", priority: "2" },
          { title: "x", priority: 3 },
        ])
          await assert.rejects(() => validation.normalizeDraft(value), TypeError);
      },
    ],
    [
      "query filters title and assignee without case sensitivity",
      async ({ query }) =>
        assert.deepEqual(
          await query.selectTickets(
            [ticket, { ...ticket, id: "t2", title: "Review", assignee: "Bob", status: "done" }],
            { search: " ADA ", status: "todo" },
          ),
          [ticket],
        ),
    ],
    [
      "query priority and numeric ID sorting",
      async ({ query }) =>
        assert.deepEqual(
          (
            await query.selectTickets([
              { ...ticket, id: "t10", priority: 1 },
              { ...ticket, id: "t2", priority: 1 },
              { ...ticket, id: "t3", priority: 2 },
            ])
          ).map((t) => t.id),
          ["t3", "t2", "t10"],
        ),
    ],
    [
      "query invalid status fails even on empty list",
      async ({ query }) =>
        await assert.rejects(() => query.selectTickets([], { status: "blocked" }), TypeError),
    ],
    [
      "empty state exact schema",
      async ({ store }) => assert.deepEqual(await store.emptyState(), empty),
    ],
    [
      "create allocates ID and normalized ticket",
      async ({ store }) =>
        assert.deepEqual(await store.applyCommand(empty, { type: "create", draft }), {
          state: populated,
          status: 201,
          body: { ticket },
        }),
    ],
    [
      "create idempotency records canonical signature and original snapshot",
      async ({ store }) => {
        const first = await store.applyCommand(empty, { type: "create", draft, key: "request-1" });
        const expected = {
          nextId: 2,
          tickets: [ticket],
          requests: [
            {
              key: "request-1",
              signature: '{"title":"Ship release","assignee":"Ada","status":"todo","priority":2}',
              ticket,
            },
          ],
        };
        assert.deepEqual(first.state, expected);
        assert.deepEqual(
          await store.applyCommand(first.state, {
            type: "create",
            draft: { ...draft, title: " Ship release " },
            key: "request-1",
          }),
          { state: expected, status: 200, body: { ticket } },
        );
      },
    ],
    [
      "idempotency conflict preserves state",
      async ({ store }) => {
        const state = {
          ...populated,
          requests: [{ key: "k", signature: JSON.stringify(draft), ticket }],
        };
        assert.deepEqual(
          await store.applyCommand(state, {
            type: "create",
            draft: { ...draft, title: "Different" },
            key: "k",
          }),
          { state, status: 409, body: { error: "idempotency_conflict" } },
        );
      },
    ],
    [
      "update preserves ID and increments revision",
      async ({ store }) =>
        assert.deepEqual(
          await store.applyCommand(populated, {
            type: "update",
            id: "t1",
            revision: 1,
            patch: { status: "doing", id: "t99", revision: 999 },
          }),
          {
            state: { ...populated, tickets: [{ ...ticket, status: "doing", revision: 2 }] },
            status: 200,
            body: { ticket: { ...ticket, status: "doing", revision: 2 } },
          },
        ),
    ],
    [
      "stale update is atomic",
      async ({ store }) =>
        assert.deepEqual(
          await store.applyCommand(populated, {
            type: "update",
            id: "t1",
            revision: 2,
            patch: { title: "Overwrite" },
          }),
          { state: populated, status: 409, body: { error: "revision_conflict" } },
        ),
    ],
    [
      "delete preserves allocation counter",
      async ({ store }) =>
        assert.deepEqual(
          await store.applyCommand(populated, { type: "delete", id: "t1", revision: 1 }),
          { state: { nextId: 2, tickets: [], requests: [] }, status: 200, body: { deleted: "t1" } },
        ),
    ],
    [
      "invalid and missing commands use stable errors",
      async ({ store }) => {
        for (const cmd of [
          null,
          { type: "unknown" },
          { type: "create", draft: { title: "" } },
          { type: "create", draft, key: " " },
          { type: "delete", id: "t1", revision: 0 },
        ])
          assert.deepEqual(await store.applyCommand(populated, cmd), {
            state: populated,
            status: 400,
            body: { error: "invalid_request" },
          });
        assert.deepEqual(
          await store.applyCommand(empty, { type: "delete", id: "t1", revision: 1 }),
          { state: empty, status: 404, body: { error: "not_found" } },
        );
      },
    ],
    [
      "storage roundtrip retains deletion retry cache",
      async ({ storage }) => {
        const state = {
          nextId: 2,
          tickets: [],
          requests: [{ key: "k", signature: JSON.stringify(draft), ticket }],
        };
        assert.deepEqual(await storage.decodeState(await storage.encodeState(state)), state);
      },
    ],
    [
      "storage rejects corruption and duplicate IDs",
      async ({ storage }) => {
        for (const value of [
          "bad",
          "null",
          JSON.stringify({ ...empty, nextId: 0 }),
          JSON.stringify({ ...populated, tickets: [ticket, ticket] }),
          JSON.stringify({ ...populated, nextId: 1 }),
          JSON.stringify({ ...populated, tickets: [{ ...ticket, revision: 0 }] }),
        ])
          await assert.rejects(() => storage.decodeState(value), TypeError);
      },
    ],
    [
      "storage validates cached signatures and keys",
      async ({ storage }) => {
        for (const cache of [
          [{ key: "k", signature: "wrong", ticket }],
          [{ key: " ", signature: JSON.stringify(draft), ticket }],
          [{ key: "k", signature: JSON.stringify(draft), ticket: { ...ticket, revision: 2 } }],
        ])
          await assert.rejects(
            () => storage.decodeState(JSON.stringify({ ...populated, requests: cache })),
            TypeError,
          );
      },
    ],
    [
      "API list and detail",
      async ({ api }) => {
        assert.deepEqual(
          await api.handleApi(populated, {
            method: "GET",
            path: "/api/tickets?status=todo&search=ada",
          }),
          { state: populated, status: 200, body: { tickets: [ticket] } },
        );
        assert.deepEqual(
          await api.handleApi(populated, { method: "GET", path: "/api/tickets/t1" }),
          { state: populated, status: 200, body: { ticket } },
        );
      },
    ],
    [
      "API routes delegate state changes",
      async ({ api }) => {
        assert.deepEqual(
          await api.handleApi(empty, { method: "POST", path: "/api/tickets", body: draft }),
          { state: populated, status: 201, body: { ticket } },
        );
        assert.deepEqual(
          await api.handleApi(populated, {
            method: "DELETE",
            path: "/api/tickets/t1",
            body: { revision: 1 },
          }),
          { state: { nextId: 2, tickets: [], requests: [] }, status: 200, body: { deleted: "t1" } },
        );
      },
    ],
    [
      "API unknown path method and invalid filter",
      async ({ api }) => {
        for (const [method, path, status, error] of [
          ["GET", "/api/secret", 404, "not_found"],
          ["PUT", "/api/tickets", 405, "method_not_allowed"],
          ["GET", "/api/tickets?status=nope", 400, "invalid_request"],
          ["GET", "/api/tickets/t9", 404, "not_found"],
        ])
          assert.deepEqual(await api.handleApi(empty, { method, path }), {
            state: empty,
            status,
            body: { error },
          });
      },
    ],
    [
      "HTML escaping complete",
      async ({ html }) => assert.equal(await html.escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;"),
    ],
    [
      "ticket rendering preserves text and required hooks",
      async ({ html }) => {
        const value = await html.renderTicket({
          ...ticket,
          title: '<img src=x onerror="alert(1)">',
          assignee: "<Ada>",
        });
        assert.ok(value.includes("&lt;img"));
        assert.ok(!value.includes("<img"));
        assert.ok(value.includes('data-id="t1"'));
        assert.ok(value.includes('data-revision="1"'));
        assert.ok(value.includes('data-action="advance"'));
        assert.ok(value.includes('data-action="delete"'));
      },
    ],
    [
      "board rendering order and empty state",
      async ({ view }) => {
        assert.match(await view.renderBoard([]), /data-empty/);
        const html = await view.renderBoard([ticket, { ...ticket, id: "t2", title: "Second" }]);
        assert.ok(html.indexOf('data-id="t1"') < html.indexOf('data-id="t2"'));
      },
    ],
    [
      "page shell hooks and local assets",
      async ({ page, styles }) => {
        const html = await page.renderPage();
        for (const text of [
          'id="ticket-form"',
          'id="board"',
          'id="search"',
          'id="status-filter"',
          'role="alert"',
          "/assets/client.mjs",
          "/styles.css",
        ])
          assert.ok(html.includes(text), text);
        assert.ok((await styles.styles()).length > 100);
      },
    ],
    [
      "HTTP CRUD and stale revision",
      (modules) =>
        withServer(modules, async (base) => {
          assert.deepEqual(await request(base, "/api/tickets"), {
            status: 200,
            body: { tickets: [] },
          });
          assert.deepEqual(await request(base, "/api/tickets", "POST", draft), {
            status: 201,
            body: { ticket },
          });
          assert.deepEqual(
            await request(base, "/api/tickets/t1", "PATCH", {
              revision: 1,
              patch: { status: "doing" },
            }),
            { status: 200, body: { ticket: { ...ticket, status: "doing", revision: 2 } } },
          );
          assert.deepEqual(await request(base, "/api/tickets/t1", "DELETE", { revision: 1 }), {
            status: 409,
            body: { error: "revision_conflict" },
          });
          assert.deepEqual(await request(base, "/api/tickets/t1", "DELETE", { revision: 2 }), {
            status: 200,
            body: { deleted: "t1" },
          });
        }),
    ],
    [
      "HTTP concurrent creates retain all IDs",
      (modules) =>
        withServer(modules, async (base) => {
          const results = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
              request(base, "/api/tickets", "POST", { title: `Task ${i}` }),
            ),
          );
          assert.ok(results.every((r) => r.status === 201));
          const list = await request(base, "/api/tickets");
          assert.deepEqual(
            list.body.tickets.map((t) => t.id),
            ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"],
          );
        }),
    ],
    [
      "HTTP simultaneous revisions allow one writer",
      (modules) =>
        withServer(modules, async (base) => {
          await request(base, "/api/tickets", "POST", draft);
          const results = await Promise.all(
            ["One", "Two"].map((title) =>
              request(base, "/api/tickets/t1", "PATCH", { revision: 1, patch: { title } }),
            ),
          );
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
          assert.equal((await request(base, "/api/tickets/t1")).body.ticket.revision, 2);
        }),
    ],
    [
      "HTTP idempotency survives editing and deletion",
      (modules) =>
        withServer(modules, async (base) => {
          await request(base, "/api/tickets", "POST", draft, { "idempotency-key": "k" });
          await request(base, "/api/tickets/t1", "DELETE", { revision: 1 });
          assert.deepEqual(
            await request(base, "/api/tickets", "POST", draft, { "idempotency-key": "k" }),
            { status: 200, body: { ticket } },
          );
          assert.deepEqual(await request(base, "/api/tickets"), {
            status: 200,
            body: { tickets: [] },
          });
        }),
    ],
    [
      "HTTP malformed JSON oversized body and private files",
      (modules) =>
        withServer(modules, async (base) => {
          const invalid = await fetch(base + "/api/tickets", {
            method: "POST",
            body: "{",
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(invalid.status, 400);
          assert.deepEqual(await invalid.json(), { error: "invalid_json" });
          const large = await fetch(base + "/api/tickets", {
            method: "POST",
            body: "x".repeat(65537),
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(large.status, 413);
          for (const path of ["/assets/server.mjs", "/assets/storage.mjs", "/board-data.json"]) {
            assert.equal(
              (await fetch(base + path, { signal: AbortSignal.timeout(5000) })).status,
              404,
            );
          }
        }),
    ],
    [
      "HTTP serves HTML CSS and browser modules",
      (modules) =>
        withServer(modules, async (base) => {
          for (const [path, type] of [
            ["/", "text/html"],
            ["/styles.css", "text/css"],
            ["/assets/client.mjs", "javascript"],
            ["/assets/view.mjs", "javascript"],
          ]) {
            const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
            assert.equal(response.status, 200);
            assert.ok(response.headers.get("content-type").includes(type));
            assert.ok((await response.text()).length > 10);
          }
        }),
    ],
    [
      "fetch client parses success and propagates API errors",
      (modules) =>
        withServer(modules, async (base) => {
          assert.deepEqual(
            await modules["api-client"].requestJson(base, "POST", "/api/tickets", draft),
            { ticket },
          );
          await assert.rejects(
            () => modules["api-client"].requestJson(base, "GET", "/api/tickets/t99"),
            /not_found/,
          );
        }),
    ],
    [
      "browser create advance filter and delete",
      (modules) =>
        withBrowser(modules, async (browser) => {
          await browser.evaluate(submit("Browser task"));
          await browser.waitFor(
            'document.querySelector("article h3")?.textContent === "Browser task"',
          );
          await browser.evaluate('document.querySelector("[data-action=advance]").click()');
          await browser.waitFor('document.querySelector("[data-status]")?.textContent === "doing"');
          await browser.evaluate(
            'const filter=document.querySelector("#status-filter");filter.value="done";filter.dispatchEvent(new Event("change",{bubbles:true}))',
          );
          await browser.waitFor('document.querySelector("[data-empty]") !== null');
          await browser.evaluate(
            'document.querySelector("#status-filter").value="all";document.querySelector("#status-filter").dispatchEvent(new Event("change",{bubbles:true}))',
          );
          await browser.waitFor('document.querySelector("article") !== null');
          await browser.evaluate('document.querySelector("[data-action=delete]").click()');
          await browser.waitFor('document.querySelector("[data-empty]") !== null');
        }),
    ],
    [
      "browser safe user text search and narrow viewport",
      (modules) =>
        withBrowser(modules, async (browser) => {
          const text = '<img src=x onerror="window.__arenaXss=1">';
          await browser.evaluate(submit(text));
          await browser.waitFor('document.querySelector("article h3") !== null');
          assert.equal(
            await browser.evaluate('document.querySelector("article h3").textContent'),
            text,
          );
          assert.equal(
            await browser.evaluate(
              'Boolean(window.__arenaXss || document.querySelector("article img"))',
            ),
            false,
          );
          await browser.command("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 1,
            mobile: false,
          });
          assert.equal(
            await browser.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
            true,
          );
          await browser.evaluate(
            'document.querySelector("#search").value="no match";document.querySelector("#search").dispatchEvent(new Event("input",{bubbles:true}))',
          );
          await browser.waitFor('document.querySelector("[data-empty]") !== null');
        }),
    ],
    [
      "browser stale update surfaces error without overwriting server",
      (modules) =>
        withBrowser(modules, async (browser, base) => {
          await browser.evaluate(submit("Original"));
          await browser.waitFor('document.querySelector("article") !== null');
          await request(base, "/api/tickets/t1", "PATCH", {
            revision: 1,
            patch: { title: "Newer" },
          });
          await browser.evaluate('document.querySelector("[data-action=advance]").click()');
          await browser.waitFor(
            'document.querySelector("#error").textContent.includes("revision_conflict")',
          );
          assert.equal((await request(base, "/api/tickets/t1")).body.ticket.title, "Newer");
        }),
    ],
  ],
  { network: true },
);
