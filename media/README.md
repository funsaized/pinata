# Pinata demo

`pinata-demo.mp4` records a real Pi orchestrator using Pinata 0.5.0's typed tools
to launch two scout subagents in parallel. Scout A inspects a small HTTP retry
client; Scout B inspects its test coverage. A research subagent waits for both
scout reports, reads them, and checks their findings against MDN's Fetch API and
Retry-After documentation. While workers run, the orchestrator's turn has ended
and Pi is idle; Herdr delivers a native completion message and Pi resumes on its
own, verifies all three tasks with `pinata_barrier`, and returns a source-linked
recommendation. No project files are changed.

Recorded on 2026-10-06, after the builder-only `ownership`/`checks` fix, with
OpenAI `gpt-6-luna` (medium thinking for the orchestrator and research, low for
scouts), Pi 1.0.3, and Herdr 0.9.1. Pi loaded
only the Pinata extension and `subagents` skill; the only extra system prompt
authorized the read-only run, named the two public MDN pages, and asked for a
three-bullet answer. The fixture's project `.pi/pinata.json` pinned the models.
Every orchestrator tool call succeeded; `pinata_delegate` accepted the job on the
first call. All three tasks succeeded, completion was delivered once, and all
worker panes and worktrees were retired.

The opening request plays at real speed; subsequent work plays at 1.5× speed.
The final frame is held for reading. Header/stage captions are editorial
annotations, and workspace labels were shortened for readability. The GIF is an
excerpt preview covering the request, typed launch, both scouts, the handoff,
research, native completion, and the result. Neither media file is included in
the npm package.

Capture: native terminal output from a 140×44 terminal attached to an isolated
named Herdr session. Render: asciinema agg 1.9.0 and FFmpeg, H.264 with a
web-compatible pixel format and fast-start metadata. No model responses or
terminal results were scripted.
