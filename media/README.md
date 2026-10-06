# Pinata demo

`pinata-demo.mp4` records a real Pi coordinator running a pinata 0.6.0 job on a
small HTTP retry client. The checkout has uncommitted work: a half-finished
Retry-After helper in `client.mjs` and a new, untracked test file. One
`/skill:engmgmt` request asks for the rest of the feature.

Pi starts two scouts (the retry loop and the tests) and a research agent (RFC
9110's Retry-After rules) in parallel, under a $0.95 cost limit it set from the
request. All three see the uncommitted files. When they finish, a builder wires
the delay into the retry loop with a 30-second cap and adds regression tests, and
an independent reviewer approves the change. Pinata integrates it on top of the
uncommitted work and runs `node --test` again: 7 passed. Nothing is committed.

The widget above the editor shows each agent's state, time, tokens, and cost
while it works. Afterwards `/pinata` prints the run without a model turn,
`/pinata-review` sends three reviewers (correctness, risk, tests) over the
result and merges their findings, and `/pinata runs` lists both runs.

Recorded on 2026-10-06 with Pi 1.0.4 and Herdr 0.9.1. The coordinator ran on
OpenAI `gpt-6-astra` (medium thinking); every worker ran on `gpt-6-luna`, pinned
by the fixture's `.pi/pinata.json`. Pi loaded only the pinata extension, Herdr's
Pi integration, the `subagents` and `engmgmt` skills, and the `/pinata-review`
prompt; one appended system line said the request was the user's approval for
this disposable repository. Workers spent $0.0088 on the build and $0.0069 on the
review. No model responses or terminal output were scripted.

Earlier takes are not shown. In two, the reviewer kept asking for changes and
the repair budget ran out, so pinata refused to integrate. In one, a coordinator
on `gpt-6-luna` added a `reviewBase` reviewer to the build job, which blocked
integration; the `subagents` skill now warns against that.

Typing, `/pinata`, and `/pinata runs` play at real speed and Pi's summaries at
1.5x. Planning plays at 2.5x, agents at work at 7x, and the review at 5x; the bar
at the bottom shows the speed. Long pauses are
shortened. The header and stage captions are editorial, and worker workspaces
were renamed from their task IDs for readability. `pinata-demo.png` is a frame
from the video. Neither file is included in the npm package.

Capture: asciinema 3.2.1 in headless mode, attached to an isolated named Herdr
session in a 140x44 terminal, driven through the Herdr CLI. Render: agg 1.9.0
and FFmpeg, H.264 with a web-compatible pixel format and fast-start metadata.
