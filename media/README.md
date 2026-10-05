# Pinata demo

`pinata-demo.mp4` records a real Pi orchestrator launching two scout subagents in
parallel. Scout A inspects a small HTTP retry client; Scout B inspects its test
coverage. A research subagent waits for both scout reports, reads them, and
checks their findings against MDN's Fetch API and Retry-After documentation.
The orchestrator then returns a source-linked recommendation. No project files
are changed.

Recorded on 2026-10-05 with OpenAI `gpt-6-luna`, Pi 1.0.3, and Herdr 0.9.1. Both
scouts and the research task succeeded; research made real documentation fetches
through pi-web-access. All three worker panes and worktrees were retired after
completion, and Herdr delivered the result notification to the original session.

The opening request plays at real speed; subsequent work plays at 1.5× speed.
The final frame is held for reading. Header/stage captions are editorial
annotations, and workspace labels were shortened for readability. The GIF is an
excerpt preview covering the orchestrator, both scouts, research, and the result.
Neither media file is included in the npm package.

Capture: native terminal output from a 140×44 terminal attached to an isolated
named Herdr session. Render: asciinema agg 1.9.0 and FFmpeg, H.264 with a
web-compatible pixel format and fast-start metadata. No model responses or
terminal results were scripted.
