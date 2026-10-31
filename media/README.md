# Pinata artwork and demo

[`pinata-hero-v2.png`](pinata-hero-v2.png) is the README illustration.
[`pinata-demo.mp4`](pinata-demo.mp4) is a 70-second edit of a real ten-agent run
building **Relay**,
a dependency-free incident-report CLI from JSONL service events.

The team consists of two scouts, three parallel module builders with independent
reviewers, and a dependent CLI builder with its own reviewer. The coordinator then
applies the reviewed changes locally and runs the full test suite and CLI example.
All 23 tests passed after integration, and the CLI example produced the expected
report. The fixture covers input validation, percentile aggregation, Markdown escaping,
CLI error handling, and their tests.

## Recording

Recorded on 2026-10-31 with the pi-pinata 2.0.1 release candidate, Pi 1.4.0,
and Node 26.7.0 on Linux. The coordinator uses OpenAI `gpt-6.1-sol` with low
thinking. Workers use `gpt-6-luna`: low for scouts, medium for builders, high for
reviewers. All workers use the in-process backend. Each builder has its own
external Git worktree.

The terminal capture is genuine Pi output from a 116×30 PTY using the built-in dark
theme. The run ID is `0b81c2b4-9584-4046-a32d-4cb945857949`. Agent conversations,
review verdicts, checks, and integration results are not synthesized. Relay is a
purpose-built disposable fixture; its final changes are left unstaged and uncommitted.
An earlier take was stopped because the recorder inherited `NO_COLOR`; the video
and source archive use the fresh color-enabled run.

The edit keeps the real Pi session visible, accelerates reading and implementation
by 8–15×, and pauses on key states for explanation. Numbered outlines highlight
parallel builders, the failed assertion, passing tests, the review verdict, and
the destination result. Pauses and playback speeds are labeled.

Chapter headings, captions, numbered outlines, terminal crops, and speed badges are editorial.
Waiting and repeated output are cut. The export is silent H.264, 1600×1000 at 15 fps,
with a web-compatible pixel format and fast-start metadata. Media is excluded from npm.

## Source and verification

[`pinata-demo-source.zip`](pinata-demo-source.zip) includes the original terminal
capture, edit decision list, renderer, recording script, starter and finished fixtures,
the run request, and saved check/review/integration evidence. Its README explains
how to render the edit offline and run the finished fixture’s tests. No credentials
are included.

## Illustration

The hero is generated artwork, not an application screenshot. It was made with the
built-in image generation tool, inspected for readable text, and saved as
`media/pinata-hero-v2.png`. The video poster is a frame from the recorded application.

Final image-generation prompt:

> Use case: ads-marketing. Asset: a polished wide PNG hero for the README of piñata, a terminal-based parallel coding-agent tool. Create a premium playful editorial composition on an almost-black indigo background. A colorful handcrafted rainbow paper donkey piñata with layered cut-paper fringes is the main visual, with thin colored ribbons branching toward small restrained terminal-inspired cards labeled "scout", "builder", and "reviewer". Convey coordinated parallel work without fabricated screenshots or metrics. Large beautifully typeset exact text: "piñata". Secondary exact text: "Small core. Parallel agents." A compact line of exact text: "Isolated worktrees · Independent review · Verified changes". Crisp readable typography, generous negative space, bright coral, yellow, turquoise and violet accents, subtle depth and lighting, refined developer-tool brand design. Landscape 16:9 composition. No additional text, no watermark, no statistics, no third-party logos.
