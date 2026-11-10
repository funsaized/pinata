# Fleet navigation and observation

The main conversation shows a compact Agents tree. Active workers have a moving
ASCII activity marker; actual children branch beneath their parent; queued work has a total
and can be expanded. Enter the fleet to select an exact worker/assignment and browse
its conversation. Execution, cleanup, delivery and assessment stay distinct.

Default keys are Shift+Down for fleet, Shift+Up for parent screen, Shift+Left/Right
for workers, Alt+Left/Right for assignments, Ctrl+X to stop, Ctrl+B to release a
foreground wait, Ctrl+R to recover and Ctrl+L to refresh. Mouse wheel and
Alt+PageUp/PageDown scroll the selected view. Commands offer the same navigation
when terminal encodings conflict. Parent and worker drafts remain separate, and a
control draft clears only after durable acceptance.

Press `?` for shortcuts relevant to the current screen and focus. In an empty
message composer, `?` opens composer help; within a draft it remains punctuation.
Tab switches between the transcript and the message composer.

Conversations follow the latest saved output by default. Scrolling away from the
bottom enters reading mode and keeps the displayed history fixed. Scrolling back
to the bottom resumes following and fetches the latest output. Arrow keys, mouse
wheel, PageUp/PageDown and Alt+PageUp/PageDown share this behavior. There is no
follow toggle. Visible live conversations refresh once per second while following.

Completion notices use the heading “Subagent result,” with worker identity,
execution outcome, summary and a conversation command. Internal versioned message
identifiers and delivery markers remain in saved session data for replay; they
are not tool names or normal display labels.

`lean` shows compact activity; `observe` includes activity excerpts. Both retain
conversation data for explicit inspection. The mode does not select a backend,
grant tools or change execution policy. Elapsed values labeled `observed` measure
only starts witnessed by that UI; saved/reconnected unknown starts are not invented.

Use `/pinata-palette <name>` or `ui.palette` to select inherit-Pi, Pinata,
Catppuccin Mocha/Latte, Gruvbox Dark/Light, Tokyo Night Night, Rose Pine Main/Dawn,
Dracula, Nord, One Dark/Light, Solarized Dark/Light or terminal-default. Semantic
tokens color status, accents and mascot consistently. Palette changes preserve
worker state and drafts. `NO_COLOR` disables colors; `TERM=dumb` or `PINATA_ASCII=1`
selects plain text glyphs. `ui.motion` supports full/reduced/off.

Key overrides use names such as `openFleet`, `parentScreen`, `previousWorker`,
`nextWorker`, `previousAssignment`, `nextAssignment`, `scrollUp` and `scrollDown`.
Keys must be valid and distinct; invalid settings fail instead of silently dropping
an action. The exact defaults and other controls are visible in the screen help.
