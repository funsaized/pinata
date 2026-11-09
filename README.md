# Pinata

An extensible subagent runtime for [Pi](https://github.com/badlogic/pi-mono).
Start workers, watch their conversations, steer them and continue their work as
the task develops. The coordinator decides what to delegate, test, review and accept.

Workers share the current checkout by default. Choose an isolated Git worktree when
you want a separate patch; inspect and apply it explicitly with conflict checks.
Completed, failed and cancelled work stays available. A completion report describes
execution, not correctness.

```sh
pi install npm:pi-pinata
```

Restart Pi, then ask it to use Pinata for a task. `@scout Map the parser and its tests`
addresses a definition directly. Shift+Up opens the fleet tree; Enter opens a worker
conversation; Shift+Left/Right changes workers; Shift+Down returns. Drafts stay with
their conversations. `/pinata` and screen commands provide keyboard fallbacks.

For a finite headless job:

```sh
pinata run examples/job.json --workspace /path/to/project --model provider/model --json
```

Choose an available model and credentials in Pi. Running workers spends provider
tokens; schema discovery, example validation and the default test suite do not.

- [First run](docs/tutorials/first-run.md): one worker, a follow-up and inspection.
- [Relay](docs/tutorials/relay.md): build a small multi-module CLI in a disposable checkout.
- [Recipes](examples/README.md): dynamic shared work, isolated follow-ups, and authorized nested/scheduled work.
- [API and schemas](docs/reference/api.md): tools, CLI, events, hooks and versioned contracts.
- [Migration](docs/reference/migration.md): preserve old runs and convert inputs explicitly.

Custom agents are Markdown files with validated model settings, tools, skills and
colors. Parent context, scoped memory, nested delegation and capacity are explicit
options. Schedules belong to a live session and resume paused after a crash. Pinata
has no automatic review policy or production token/time budget.

The Pi extension, headless CLI, authenticated IPC and saved-run viewer use one
runtime and event model. Available backends are in-process, supervised process and
optional Herdr. Node 22.19+ is required. Linux/macOS have scripted validation;
Windows runtime verification is deferred and its process supervisor helper is not
yet available. See [platform support](docs/how-to/platforms.md).

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run arena -- --offline
```

Tests and benchmarks use scripted or loopback providers. They establish behavior
and coordination overhead; they do not establish improved model coding performance.
See [testing](docs/maintainers/testing.md), [architecture](docs/explanation/architecture.md)
and [the implementation record](docs/maintainers/rewrite-progress.md).
