# Pinata demo

[`pinata-demo.mp4`](pinata-demo.mp4) is a 50-second introduction to piñata:

- **Meet your subagents.** The animated piñata opens the video, with a callout
  identifying its ribbons as subagents.
- **Work in parallel.** Two builders work on a service checker and its report.
- **Review and land.** Independent reviewers check the changes, a builder fixes
  a reported bug, and the finished app passes 17 tests.

The edit keeps the terminal frame, uses three chapters, and holds on a handful
of readable moments. Backend choices, mode switching, steering, external
viewers, and headless operation are left to the documentation.

## Recording and editing

Recorded on 2026-10-29 with pi-pinata 1.0.0 (application commit `d09c20a`),
Pi 1.1.0, and Node 26.7.0 on Linux. The coordinator uses OpenAI `gpt-6.1-sol`
with medium thinking. Workers use `gpt-6-luna`: low for scouts, medium for
builders and the planner, high for reviewers.

The terminal output, model responses, review verdicts, tests, and agent states
come from real runs in 116×30 PTYs. Pulse is a disposable demonstration fixture
with local HTTP services. The opening and closing preview the verified mascot
view reopened after integration; the middle follows the build and its result.
The demonstration leaves four changed files unstaged and uncommitted.

Headings, chapter labels, ribbon callouts, captions, and crops are editorial.
Playback speeds are marked; setup, waiting, and repeated output are cut.
The export is silent H.264, 1600×1000 at 15 fps, with a web-compatible pixel
format and fast-start metadata. The media directory is excluded from npm.

## Source

[`pinata-demo-source.zip`](pinata-demo-source.zip) contains the original terminal
captures, revised edit decision list and renderer, starter and finished fixtures,
headless job, and verification evidence. Its README explains offline rendering
with Python, pyte, Pillow, FFmpeg, and a monospaced font.
