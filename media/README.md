# Pinata demo

[`pinata-demo.mp4`](pinata-demo.mp4) is a two-minute walkthrough of piñata 1.0
running in Pi. A team upgrades **Pulse**, a small service-health checker, with
bounded concurrency, deadlines, retries, a terminal report, and regression tests.

The walkthrough shows:

- **Lean mode:** two scouts investigate in parallel, then a planner uses both reports.
- **Observe mode:** a process-backed checker builder and an in-process dashboard
  builder work on separate files, each with an independent reviewer.
- **Inspection and steering:** `/pinata open` shows a live agent; a steer asks for
  a regression covering a cleanup operation that never settles.
- **An external viewer:** `pinata view` follows the same run from another terminal.
- **Review and repair:** the checker reviewer catches a late-response cleanup
  leak. The builder repairs it in the same worktree, adds a regression, and gets
  a fresh approval.
- **Verified integration:** `pinata_integrate` applies the approved changes and
  passes the integrated checks. A separate test run shows **17 tests passing**.
- **The result:** five real local HTTP endpoints exercise healthy responses,
  a successful retry, a timeout, and a non-retryable 404.
- **Headless operation:** `pinata run ../audit.json --mode observe` runs two
  real audits and exits with code 0.

The live mascot view is connected to the verified build run. The demonstration
leaves its four changed files unstaged and uncommitted.

## Recording and editing

Recorded on 2026-10-29 with pi-pinata 1.0.0 (application commit `d09c20a`),
Pi 1.1.0, and Node 26.7.0 on Linux. The coordinator uses OpenAI `gpt-6.1-sol`
with medium thinking. Workers use `gpt-6-luna`: low for scouts, medium for
builders and the planner, high for reviewers. Pi loads the pinata extension
and the repository's `subagents` skill in an isolated configuration.

Both terminals are actual 116×30 PTYs. Model responses, tool output, review
verdicts, tests, and agent states come from real runs. Pulse is a disposable
fixture written for the demonstration; its HTTP server runs locally.

The headings, chapter strip, captions, and terminal crops are editorial.
Playback speeds are marked; setup, waiting, and repeated output are cut.
The opening shot previews the build, and the closing shot returns to its result.
The verified live view was reopened after integration. Earlier takes are omitted.

The export is a silent H.264 MP4 at 1600×1000 and 15 fps, with a web-compatible
pixel format and fast-start metadata. The media directory is excluded from the
npm package.

## Source

[`pinata-demo-source.zip`](pinata-demo-source.zip) contains the original terminal
captures, edit decision list, offline renderer, starter and finished fixtures,
headless job, and verification evidence. Its README explains how to re-render
the video with Python, pyte, Pillow, FFmpeg, and a monospaced font.
