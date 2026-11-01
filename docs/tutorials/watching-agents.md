# View and steer agents

The widget above Pi's editor shows agent status, elapsed time, tokens, cost, and the
current tool. Click its first line or run:

```text
/pinata view
```

The workspace shows an animated piñata, an agent list, and streaming conversations.
You can open it before work starts: it picks up new runs automatically. If nothing is
running, it opens the latest saved run. Naming a run pins it:

```text
/pinata view <run>
/pinata view --task build
/pinata view <run> --task build
```

Use ↑/↓ to select an agent and Enter to focus its conversation. Tab switches between
the agent list and conversation; on narrow terminals each gets the full width.
Scroll with the mouse wheel, ↑/↓, or PgUp/PgDn. End resumes following the latest output.
Ctrl+O expands tool output. Esc returns to Pi. M toggles motion and Space bonks the mascot.

## Steer a running agent

With the conversation focused, press Enter, type, and press Enter again. The message
reaches the agent before its next model request. Alt+Enter queues a follow-up instead.
Every steer is recorded, and the builder's reviewer is told about it.

Esc cancels a draft first. New runs, agent navigation, and clicks cannot redirect a draft.
Saved conversations are read-only.

## Use another terminal

In the Pi session that owns the run:

```text
/pinata view --external
```

It prints a command to run in another terminal in the repository (_manual_):

```sh
pinata view <run>
```

Both entry points use the same workspace and controls. `--task <task>` focuses a
conversation. Inside Herdr, `--external` opens a viewer pane automatically. Observe mode
also enables external streaming when the run starts.

You can run bare `pinata view` before a run exists, or use it to inspect saved runs without
any setup. Without a connection to the owning Pi, it follows the log read-only; lean mode
saves conversations when agents finish. Use `--external` for live streaming and steering.
An open log viewer connects when the run's socket becomes available.

For text output, use `pinata logs <run> [--task <task>]`; add `--follow` to follow recorded events.
