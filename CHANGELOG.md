# Changelog

## 1.0.0-next.0

A new engine. pinata 0.7.0 ran every agent as a separate Pi in a Herdr workspace with a file-based
coordinator; 1.0 runs agents inside your Pi by default, with the same roles, reviews and
integration, and works on Linux, macOS and Windows without Herdr.

### Faster and lighter

- Agents run in process by default: on the reference machine an agent sends its first model
  request about 2 ms after it starts (0.7.0: about 1.4 s) and uses about 1–2 MB (0.7.0:
  about 218 MB). A dependent starts well under a millisecond after its predecessor settles.
- Loopback A/B against 0.7.0: every scenario is faster, for example 8 parallel scouts in
  0.34 s instead of 4.8 s, and a 64-agent mix in 0.64 s instead of 21.6 s.
- Luna quality eval: 0.94 (0.7.0: 0.69), with no result-format failures.

### New

- Three backends: `in-process` (default), `process` (a `pi --mode rpc` child per agent) and
  `herdr-pi` (an interactive Pi in its own Herdr pane).
- `survive: true` runs keep going when Pi exits; the next Pi resumes them, and a headless host
  finishes them if Pi is closed. `/pinata rerun` restarts tasks lost in a crash.
- A widget with one row per agent, a footer, `/pinata open` (an agent's conversation, live, with
  steering), `/pinata live` (the mascot), and `/pinata watch` with `pinata view` (a viewer in
  another terminal, over an authenticated local socket).
- Lean and observe modes; observe keeps the full event stream, live transcripts and telemetry.
- The `pinata` command: `run` (headless jobs with exit codes), `view`, `logs`, `resume`, `gc`.
- Reviewers see when their builder was steered. Pull request and branch reviews.

### Changed

- Runs log events to `events.jsonl`; results, transcripts and `run.json` sit beside it in
  `<git common dir>/pinata/<run>`.
- Configuration adds `mode` and `backend`; `pi`, `herdr`, `session`, `workspaceReuse` and
  `limits.startupMs` are ignored with a notice. Default concurrency is 16 (at most 64).
- Requires Pi 1.1.0+ and Node 22.19+.

### Removed

- 0.7.0's helper (`lib/`), its file-based coordinator and Herdr-only supervisor. `pinata gc
--confirm` retires 0.7.0 run directories with 0.7.0's rules and keeps their evidence.
