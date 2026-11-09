# Replacement UI

The Pi extension and standalone viewer share the same screen router, projections,
conversation reader and command receipts. Opening a screen never requests a model
turn. Pi uses its public full-viewport overlay API and keeps a compact fleet
widget in the coordinator conversation only while assignments are active or queued.
Unresolved failed/interrupted assignments remain visible in the compact widget,
even if only dependents are queued. Opening a screen replaces that widget; returning restores it. Both views leave an
editor margin. Idle fleets remain accessible through /pinata.

## Navigation and controls

| Input                                   | Action                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Shift+Down                              | Open the fleet from the coordinator, or return to the fleet from a worker |
| Shift+Up or Escape                      | Return to the parent screen: conversation → fleet → coordinator           |
| Shift+Left / Shift+Right                | Select the previous / next worker                                         |
| Enter in the fleet                      | Open the selected assignment                                              |
| Mouse wheel / Alt+PageUp / Alt+PageDown | Scroll the fleet or retained conversation                                 |
| Click / double click in the fleet       | Select / open the visible assignment                                      |
| Q in the fleet                          | Expand or collapse queued assignments                                     |
| Alt+Left / Alt+Right                    | Browse earlier / later assignments for that worker                        |
| Ctrl+Left / Ctrl+Right                  | Additional main / fleet / conversation cycling                            |
| Ctrl+X                                  | Cancel the selected worker's pending assignments                          |
| Ctrl+B                                  | Release the foreground wait into background                               |
| Ctrl+R                                  | Reconcile or reattach the selected owned assignment                       |
| Ctrl+L                                  | Refresh the conversation, or reconnect a disconnected attachment          |

The default worker arrows use Shift because Pi's fullscreen viewport consumes
Ctrl+Up/Down before custom components receive them. Ctrl+Left/Right, Ctrl+B and
Ctrl+R retain editor behavior while the conversation composer has focus; use Tab
for transcript controls or the explicit slash commands. Named shortcuts are configurable (navigation keys are reserved)
through `ui.keys`: `openFleet`, `parentScreen`, `previousScreen`, `nextScreen`,
`previousWorker`, `nextWorker`, `previousAssignment`, `nextAssignment`, `stop`,
`background`, `recover`, and `refresh`. Duplicate or unsupported key definitions
are rejected. Terminals may reserve additional combinations; the command routes
remain available.

At the coordinator, use `/pinata`, `/pinata-main`, `/pinata-fleet`,
`/pinata-conversation <worker> [assignment]`, or `/pinata-palette <name>`.
Inside a worker screen, `/worker <id> [assignment]`, `/assignment <number>`,
`/fleet`, and `/main` provide navigation without modifier keys. `/help` lists the
local controls.
`/scroll up` and `/scroll down` are available when the terminal reserves scroll
keys; Pi's viewport consumes bare PageUp/PageDown before custom components.

Ordinary submitted text steers the visible active or queued assignment. After
settlement it creates a follow-up for completed work, or continues stopped work as
a new assignment. Explicit `/steer`, `/follow-up`, and `/continue` are available.
The router rejects steering when an older visible assignment is no longer the
actual control target. A durable accepted receipt clears only the submitted draft;
text edited while the request was pending is retained. An uncertain receipt keeps
the same request and message IDs for an explicit retry.

`/stop`, `/stop-assignment`, and `/stop-run` name the cancellation scope.
`/background` releases a foreground wait; it does not change launch-time host
survival. `/inspect` reads retained results, `/recover` reconciles owned activity,
and `/replace <new-worker-id> <task>` explicitly creates another worker with the
selected exact assignment as its origin. This provenance does not implicitly copy
conversation/context or expand grants.
`/reconnect` obtains fresh authenticated authority for a disconnected IPC source;
it never retries a mutation automatically. Saved sources remain read-only.

The standalone commands are `pinata view <run-directory>` and
`pinata attach <run-directory>` in a terminal. Add `--control` to request the
owner's control channel or `--saved` for retained data. Noninteractive `attach`
prints status, and `--json` or `--watch` preserves the structured CLI path.
`--palette <name>` is a local viewer preference.

## Factual projections

Each assignment shows execution reason, cleanup, shared or isolated delivery,
notification state, worker-reported assessment, and recorded acceptance separately.
Execution completion does not become a review or correctness claim. Context usage
shows reported tokens/window/percentage with its source and timestamp, or unknown;
cumulative token usage is a separate value. Worker ancestry, queue readiness,
actual backend/workspace/lifetime, and session-owned schedules remain visible.

The coordinator widget and fleet use a compact Agents tree: bold colored agent
names, worker/assignment identity, task summaries and actual recorded ancestry.
A bottom row counts queued assignments. The UI shows observed elapsed time only
when it witnessed the assignment start; reconnecting or opening an already-active
assignment does not invent a start time. This display timing is not persisted.

`mode: lean` omits transient output excerpts.
`mode: observe` adds indented bounded activity lines. Both modes
retain identical execution, accounting and conversation evidence. The canonical
`config` query supplies accepted intent to live and saved views; the Pi host's
initial settings apply before a config has been accepted. A local palette switch
does not change accepted configuration or restart workers.

Conversation pages distinguish saved assignment transcripts, session checkpoints,
and unavailable content. Asynchronous results cannot overwrite a newer selection.
Worker drafts survive navigation and resize; reopening a conversation follows its
latest output. Scroll positions stay fixed while reading within that view; the
coordinator draft is restored when the custom screen closes. Transient activity is
bounded to 64 assignment tails of 4,096 characters; full retained conversations are
read separately through paginated queries.

## Palettes and motion

The initial palette is `inherit`, using Pi's theme. The standalone viewer has a
dark semantic fallback when there is no Pi theme. Inherited accents use Pi's
public theme tokens for distinct agent, workspace, context and status colors.
Headers and controls separate muted labels from colored values; run identifiers
remain available in details. Available palettes are:

- `pinata`
- `catppuccin-mocha`, `catppuccin-latte`
- `gruvbox-dark`, `gruvbox-light`
- `tokyo-night-night`
- `rose-pine-main`, `rose-pine-dawn`
- `dracula`, `nord`, `one-dark`, `one-light`
- `solarized-dark`, `solarized-light`
- `inherit`, `terminal-default`

Each explicit palette paints its own background and semantic text colors. Some
family colors are adjusted for readable terminal text. Tests require at least
4.5:1 contrast for primary/muted text and 3:1 for semantic accents against the
selected background. Agent accents and the Pinata badge use the same palette;
definition-supplied colors remain explicit overrides.

`NO_COLOR`, `TERM=dumb`, and `terminal-default` disable palette escape sequences.
`PINATA_ASCII=1` or `TERM=dumb` uses an ASCII badge and `|` / `-` tree branches. Worker content is sanitized
before styling, including OSC/APC escape sequences and bidi controls, while
preserving emoji, combining characters and CJK text. Screens are static in all
motion modes; reduced/disabled motion does not hide information or change work.

## Verification and retained evidence

`node --test test/engine/rewrite-ui.test.ts` covers stale selection, draft and
receipt behavior, exact targets, all palettes, hostile terminal text, grapheme
width, narrow screens, real scripted runtime control, IPC reconnect, canonical
live/saved configuration and the terminal CLI entry point. One hundred screen
lifetimes and one hundred viewer lifetimes return subscriptions, terminal input
handlers and timer counts to their baselines.

The eight-worker local responsiveness test records 320 event and 40 key samples.
Observed Linux Node 26 p95 values were below 0.1 ms for event-to-render-request and
below 0.2 ms for key-to-render-request, against the 100 ms target. These are local
render-request timings, not provider latency or terminal screen-paint timings.

The isolated offline terminal driver retains actual PTY bytes, event records and
colored renderer-frame HTML:

```sh
python3 test/readiness/rewrite-ui-pty.py --root "$PWD" \
  --out bench/results/rewrite-ui-unique \
  --pi node "$PWD/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
```

The driver rejects provider requests, uses an empty agent directory, and checks
three visits at 120, 60 and 30 columns, three palettes, streaming updates,
modifier-arrow worker navigation, parent/worker drafts and disposal. Its F12
shortcut is test instrumentation; normal users open the fleet with Shift+Down.

Linux pinned Pi 1.1.0 and native Pi 1.5.0 passed the final navigation capture in
`bench/results/rewrite-ui-linux-sdk-tree-1/` and
`bench/results/rewrite-ui-linux-native-tree-1/`. The owner accepted the compact tree
layout shown in the SDK capture's `review-fleet.png`. Earlier failed attempts remain:
SDK attempt 1 exposed Ctrl+Up/Down interception; SDK attempt 3 and native attempt 2
used a capture shortcut that Pi reserves for its external editor. Subsequent
captures use an unbound test shortcut. Passing intermediate captures and the
`NO_COLOR` terminal output are retained too.

The production-path macOS captures passed with Node 22.23.1 and 26.9.0 using
pinned Pi 1.1.0, and with the installed Pi 1.5.0 Node CLI. Each exercised the same three widths,
palettes, draft/navigation/scroll checks and disposal with zero provider calls.
Their raw terminal and frame evidence is retained in
`bench/results/rewrite-macos-cutover-20261108T225304Z/evidence/` under
`ui-sdk-node22`, `ui-sdk-node26` and `ui-native`. The historical `ui-native` directory
name identifies the installed CLI; it does not establish compiled Bun execution
on macOS. Compiled Pi was exercised on Linux. No Windows terminal execution is
claimed here.

## Fleet interaction and presentation

Fleet arrows select rows; Enter opens the selected assignment. Left/Right collapse
and expand real child branches. Dependencies remain explicit waiting reasons.
`/` edits a worker/task search; Enter retains it, and reopening search and deleting
its text clears it. `f` cycles all/active/failed, `h` includes older assignments,
`Q` shows queued work, and `q` returns to the coordinator. Filtering moves selection
to a visible match. `?` opens scrollable help with configured bindings. `a` opens an
action list whose labels distinguish assignment, worker, and run scopes.

In conversations, Tab switches composer/transcript focus. A reverse-video badge
names the active focus (AGENT MESSAGE or TRANSCRIPT) and the selected worker;
the composer border is accented while typing to the agent. Plain terminals retain
the explicit labels. The composer retains
Ctrl+Left/Right, Ctrl+B and Ctrl+R for editing. Transcript focus enables `f` to follow
latest output, `d` to expand metadata and tool payloads, and `m` to load older pages.
Scrolling disables follow mode without changing the draft. The composer identifies
whether ordinary text will steer, follow up, or continue.

Full motion animates active markers at four frames per second; reduced/off use
static markers. Elapsed observations update once per second without animation.
Timers stop when no view is subscribed or no assignment is active. Pi's own
16 ms render scheduler coalesces paint requests; per-view bounded wrapping caches
avoid repeatedly wrapping unchanged transcript text.

Pi tool cards summarize calls and results; expansion retains complete structured
details. Model-facing agent discovery is compact and includes effective grants,
model defaults and backend capabilities. Unnamed schema queries return an index
to the model; canonical query details retain the complete schemas. Neither compact
presentation nor animation changes execution, acceptance, or recovery authority.

## Retained conversation rendering

Shift+Down opens the fleet from the Pi editor or a worker conversation.
Shift+Up returns from a worker to the fleet, and from the fleet to Pi.

The panel fills the terminal, including after resize, with controls and the composer
anchored at the bottom. Pi conversations use its native user-message cards, Markdown
theme and syntax highlighter. Expanded tool arguments and read results also receive
syntax highlighting; terminal-default and no-color modes retain plain rendering.
Backend and context metadata remain available through the details toggle. Tool
calls retain individual tool/path labels and four-line output previews; errors
show up to eight lines. The details toggle expands complete payloads. Recorded
`submit_result` reports are displayed as worker reports, including findings, even
when other tools show only previews. These are worker claims, not coordinator acceptance.

Opening or reentering a conversation follows the latest output and read subsequent immutable
pages until they reach the end; scrolling switches to history mode and stops
automatic paging. Refreshes collect pages before replacing the displayed transcript,
so loading does not flash the first page or shift content. History stays fixed until
the user follows new output; scrolling a transcript that already fits does not
disable following. Full tool details remain available through Tab then d.
