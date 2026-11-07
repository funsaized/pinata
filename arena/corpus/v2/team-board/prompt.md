# Team Board: plan and build a small full-stack app

Build a working team ticket board: Node HTTP API, durable JSON state, and a
responsive browser UI. No build step, database service, packages or framework
installation is needed. Use Node built-ins and browser-native ESM/DOM APIs.

Start by making an execution plan with a dependency DAG, file ownership,
independent parallel work, interface handoffs, integration checkpoints, and checks.
Then immediately execute it using the specified orchestration framework. Do not
stop at a plan. Coordinate the API/frontend contracts and integrate a working app.

Twelve module boundaries are supplied as planning hints. Foundation branches
(validation, query, escaping, styles, page shell, fetch client) can progress
concurrently. Validation feeds state/storage; state and query feed API; escaping
feeds board rendering; page/view/fetch client feed browser integration; server
joins API, storage, page, styles and frontend assets. You may choose task sizes and
reviews, but each implementation file has one public unit owner. Add local tests
as useful and explicitly assign any added test files. Do not install packages.

All exports below are named. Pure helper functions must not mutate arguments,
including nested objects: frozen inputs must work. Return only documented fields.
Extra input fields are ignored. Node-side modules must import without starting a
server; browser modules must import safely when `document` is absent.

## validation.mjs — normalizeDraft(value)

Accept a non-null non-array object. Return `{title,assignee,status,priority}`.
Title is a string, trimmed, length 1–100. Assignee defaults to "" only if undefined;
it must be a string, trimmed, at most 40 characters. Status defaults to "todo"
only if undefined; choices are exactly "todo", "doing", "done". Priority defaults
to 1 only if undefined; it is an integer 0, 1 or 2. Throw TypeError otherwise.

## query.mjs — selectTickets(tickets, query={})

Tickets are valid records. Filter by `query.status` (default "all"; also todo,
doing, done), rejecting other statuses with TypeError. `query.search` defaults to
"", is trimmed and matched case-insensitively as a substring of title + space +
assignee. Query fields are strings when supplied. Sort by priority descending,
then numeric ID ascending (t2 before t10). Return independent ticket copies.

## store.mjs — emptyState(), applyCommand(state, command)

`emptyState()` returns `{nextId:1,tickets:[],requests:[]}`. A ticket is
`{id,title,assignee,status,priority,revision}`. IDs are t1,t2,…, allocated from
nextId; revision starts at 1. Never recycle IDs after deletion.

`applyCommand` returns `{state,status,body}`. Inputs are immutable. Errors preserve
state and return `{error:CODE}` as body. Invalid commands/fields -> 400
invalid_request; missing ticket -> 404 not_found; stale revision -> 409
revision_conflict. For update/delete, validate command shape/revision first, then
existence, then revision, then draft patch. Use a positive safe-integer revision.

- `{type:"create",draft,key?}`: normalize draft. Optional key is an opaque string
  of length 1–64 containing at least one non-whitespace character. New create ->
  201 `{ticket}`, append ticket, increment nextId. Unsafe nextId increment -> 400.
  An identical retry with the same key and NORMALIZED draft -> 200 and the original
  created ticket snapshot, even if subsequently edited/deleted. A different draft
  with the same key -> 409 idempotency_conflict. No key means no deduplication.
- `{type:"update",id,revision,patch}`: patch is an object; merge it over the current
  ticket, normalize draft fields, preserve ID, increment revision. Return 200
  `{ticket}`. Ignore patch fields id/revision after normalizing draft. Never let a
  caller replace IDs or reset revisions.
- `{type:"delete",id,revision}`: remove ticket, preserve nextId and request cache;
  return 200 `{deleted:ID}`.

State request-cache entries are `{key,signature,ticket}` in insertion order.
Signature is JSON.stringify of the normalized draft, in the field order returned
by normalizeDraft. Cached ticket is the original revision-1 snapshot. State ticket
order is creation order. Return copies in bodies so callers cannot mutate state.

## storage.mjs — encodeState(state), decodeState(text)

Encode returns JSON text; decode returns a normalized independent state. Persist
nextId, tickets, AND the idempotency cache. Reject corrupt JSON/state with
TypeError("invalid_state"). nextId is a positive safe integer. Ticket IDs match
`t[1-9][0-9]*`, their numeric suffix is a safe integer below nextId, IDs are unique,
and revisions are positive safe integers. Validate/normalize draft fields. Cache
keys are valid and unique, signatures match the normalized cached draft, and
cached tickets have valid IDs below nextId and revision exactly 1. Deleted tickets
may still have cached snapshots. Strip unrecognized fields. No filesystem I/O here.

## api.mjs — handleApi(state, request)

Pure transport-independent API. Request has method, path (including optional query
string), optional body (already decoded), optional lowercase-key headers. Return
`{state,status,body}`; use the store/query helpers.

- GET /api/tickets: 200 `{tickets}` using search/status query filters.
- POST /api/tickets: create from body; optional `idempotency-key` header.
- GET /api/tickets/tN: 200 `{ticket}` or 404 not_found.
- PATCH /api/tickets/tN: body `{revision,patch}`.
- DELETE /api/tickets/tN: body `{revision}`.
- Unsupported method on one of those recognized paths: 405 method_not_allowed.
- Unknown path: 404 not_found. Invalid query/draft/command: 400 invalid_request.

## html.mjs — escapeHtml(value), renderTicket(ticket)

Escape &, <, >, double quote, apostrophe as &amp;, &lt;, &gt;, &quot;, &#39;.
Render a ticket as an article with `data-id` and `data-revision`, a h3 title,
assignee text, a `[data-status]` element, priority text, and type=button buttons
with `data-action="advance"` and `data-action="delete"`. Escape all user text;
never allow ticket content to become markup, attributes, or executable JavaScript.

## view.mjs — renderBoard(tickets)

Return joined rendered tickets in supplied order. Empty array returns a visible
empty-state element with `data-empty` and text "No tickets yet".

## page.mjs — renderPage()

Return a complete accessible HTML document titled "Team Board", viewport meta,
stylesheet /styles.css, module script /assets/client.mjs, and these hooks:

- form#ticket-form: labeled controls name=title (required, max 100), assignee
  (max 40), priority (select 0/1/2, default 1), and submit button "Add ticket".
- input#search and select#status-filter (all/todo/doing/done, default all), labeled.
- #error with role=alert and aria-live=polite.
- main#board as ticket container.

## styles.mjs — styles()

Return readable responsive CSS: distinguish cards, controls, error state; use a
multi-column grid on wide screens and a usable layout at 390px. No remote assets.

## api-client.mjs — requestJson(base,method,path,body?,headers={})

Use fetch(base+path). Send JSON body only if supplied and Content-Type
application/json. Merge supplied headers. Parse JSON response. Resolve its object
for successful HTTP status; otherwise throw Error with the response's error code
(or request_failed when unavailable). Do not swallow network errors.

## client.mjs — mount(doc=document)

Wire the page to the real API, using requestJson and renderBoard. Auto-mount only
when document exists. Load tickets initially. Form submission creates a ticket and
resets only on success. Search input and status change refresh filters. Advance
cycles todo -> doing -> done -> todo via PATCH with the card's current revision.
Delete sends DELETE with the card revision. Refresh after successful mutations.
Show API/network errors as text in #error; clear prior errors on a new action.
An optimistic conflict must not silently overwrite the newer server state.
Preserve literal user text in rendered cards (including script-like text).

## server.mjs — startServer(options={}), stopServer()

Create a real HTTP server bound to 127.0.0.1. options.port defaults to 0 (ephemeral),
options.dataFile defaults to null (memory mode). startServer resolves `{port}`;
stopServer closes all connections and resolves null. Only one server is active per
module instance. Memory state resets on each fresh start. Do not start on import.

Serve GET / as HTML, /styles.css as CSS, and only the four browser modules client,
api-client, html, view under /assets/NAME.mjs as JavaScript. Backend source and
arbitrary paths must not be served. API responses are JSON. Malformed JSON -> 400
`{error:"invalid_json"}`; bodies over 65536 bytes -> 413 `{error:"too_large"}`.
Serialize API state transitions so simultaneous writes cannot lose updates or
bypass revision checks. When dataFile is set, load/validate it on startup (missing
file starts empty), atomically save every successful state change BEFORE replying,
and retain state/cache across restarts. Disk-save failure -> 500 internal_error,
without advancing in-memory state. A corrupt existing file must fail startup.

When run directly as `node server.mjs`, use PORT (default 3000) and DATA_FILE
(default board-data.json); log the loopback URL. The scored HTTP/browser tests use
memory mode and test serialization separately; disk restart behavior is a public
requirement and separately checked by the development suite.

Acceptance: build a coherent working app, not stubbed helper responses. Verify
pure logic, real HTTP API, and browser create/filter/advance/delete/error flows.
No external oracle or reference solution is available to agents.
