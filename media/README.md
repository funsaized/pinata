# Pinata demo

`pinata-demo.mp4` records a real Pi coordinator running a pinata 0.6.0 job on a
small HTTP retry client. The checkout has uncommitted work: a half-finished
Retry-After helper in `client.mjs` and a new, untracked test file. One
`/skill:engmgmt` request, pasted in one go, asks for the rest of the feature.

Pi starts two scouts (the retry loop and the tests) and a research agent (RFC
9110's Retry-After rules) in parallel, under a $0.95 cost limit it set from the
request. All three see the uncommitted files. When they finish, a builder wires
the delay into the retry loop with a 30-second cap and adds regression tests. The
independent reviewer asks for a stronger ordering test. The builder's first
repair fails pinata's own check, because the files it reported did not match what
it changed; the second repair passes, and the reviewer approves the new change. Pinata integrates it on top of the
uncommitted work and runs `node --test` again: 6 passed. Nothing is committed.

The widget above the editor shows each agent's state, time, tokens, and cost
while it works. Afterwards `/pinata` prints the run without a model turn,
`/pinata-review` sends three reviewers (correctness, risk, tests) over the
result and merges their findings, and `/pinata runs` lists both runs.

Recorded on 2026-10-06 with Pi 1.0.4 and Herdr 0.9.1. The coordinator ran on
OpenAI `gpt-6-astra` (medium thinking); every worker ran on `gpt-6-luna`, pinned
by the fixture's `.pi/pinata.json`. Pi loaded only the pinata extension, Herdr's
Pi integration, the `subagents` and `engmgmt` skills, and the `/pinata-review`
prompt; one appended system line said the request was the user's approval for
this disposable repository. Workers spent $0.020 on the build and $0.006 on the
review. No model responses or terminal output were scripted.

Earlier takes are not shown. In two, the reviewer kept asking for changes and
the repair budget ran out, so pinata refused to integrate. In one, a coordinator
on `gpt-6-luna` added a `reviewBase` reviewer to the build job, which blocked
integration; the `subagents` skill now warns against that.

The request, `/pinata`, and `/pinata runs` play at real speed and Pi's summaries
at 3x. Planning plays at 6x, agents at work at 12x, and the review at 10x; the
bar at the bottom shows the speed. Long pauses are
shortened. The header and stage captions are editorial, and worker workspaces
were renamed from their task IDs for readability. The video is not included in
the npm package.

Capture: asciinema 3.2.1 in headless mode, attached to an isolated named Herdr
session in a 140x44 terminal, driven through the Herdr CLI. Render: agg 1.9.0
and FFmpeg, H.264 at 15 fps with a web-compatible pixel format and fast-start
metadata, under 10 MB so it can be uploaded to GitHub.
