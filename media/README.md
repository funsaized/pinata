# README recordings

The fleet image and video show live `openai/gpt-6.1-sol` workers; the navigation
GIF uses `openai/gpt-6-luna`. Both runs use low reasoning in Piñata's terminal UI. They were captured on 2026-11-12 from the branch
`fix/fleet-finished-visibility`. The task uses a temporary project: a Node CLI
that parses NDJSON latency records and reports service counts, errors and p95.
The [recording manifest](pinata-recording.json) records the source commit, run IDs,
parent relationships, outcomes, usage and encoding settings.

- `pinata-fleet.png`: a frame from the nested fleet while its two builder children
  are active. The lead, scout and reviewer are root workers; the parser and summary
  builders are actual children of the lead.
- `pinata-fleet.mp4`: the same run from launch through implementation, review and
  inspection of completed work. Execution plays at 6× speed; the final inspection
  screens play at normal speed so the review remains readable.
- `pinata-navigation.gif`: a separate two-worker run, showing selection, Enter to
  open, Shift+Left to change workers, Shift+Up to return, search and clearing the
  filter, then `h` to show finished work and reopen a retained conversation.

The video is 27 seconds; the navigation GIF loops in 23 seconds. The image is
1600 × 1000, the MP4 uses H.264 at the same size, and the GIF is 1200 × 750.

The capture binds `ScreenRouter` and `PinataScreen` to a live `openHost` source.
It samples the production renderer at 124 columns by 30 rows every 250 ms and
sends navigation keys through `PinataScreen.handleInput`. A terminal renderer
renders the ANSI colors, cell positions and cursor; the surrounding title,
caption and key labels are presentation added for the recording. The assets
are not desktop screen captures. Model responses, tool results, execution states
and parent/child relationships come from the live runtime.

The demo uses the in-process backend and a shared temporary checkout. The lead
chooses the child tool calls. The recording harness launches the root workers
and sets the review dependency on the lead and scout. It does not use a model
for the root coordinator. Completion reports execution status; these recordings
are examples, not a coding-quality benchmark.

The nested fleet project's six tests and sample CLI invocation passed a separate
coordinator check. The sample produces two services, one server error and one
invalid input line. Private credentials and full session stores are kept out of
this repository.

## GitHub display

The committed PNG and GIF display directly in the README. The video link points
to the committed MP4. To add GitHub's inline video player, drag
`pinata-fleet.mp4` into a GitHub Markdown editor and replace the README video link
with the resulting `https://github.com/user-attachments/assets/...` URL on its
own line. Keep the committed file as the downloadable original. See
[GitHub attachment instructions](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files).
