# Watching agents

This tutorial tours every way to watch a run: the widget, an agent's conversation, steering,
the mascot, and a viewer in another terminal.

## The widget and footer

While a run of this Pi session works, the widget above the editor lists each agent:

```text
/)/) pinata 0f3c9a51 · 1/3 done · 1 running · 5.4k tok · $0.012
✓ scout    map  in 9.0s 2t 4⚒ 5.4k $0.012 — Mapped the parser and its tests
▸ builder  build  in 12.0s 1t 1⚒ — edit src/date.ts
· reviewer review — queued
```

It updates as events arrive, at most four times a second, and uses no timers while
nothing changes. Clicking the first line opens `/pinata live`.

## An agent's conversation

```text
/pinata open build
```

`/pinata open` and `/pinata live` share one rainbow-framed workspace: the animated piñata
and agent list on the left, the selected conversation on the right. `open build` starts
with the builder's conversation focused. `live` starts with the agent list focused.
The active pane has a `▸` marker, and the selected agent is highlighted.

- **Agent list:** ↑/↓ select an agent and preview its conversation; Enter focuses it.
  Clicking an agent also opens its conversation. ←/→ switch runs when more than one is available.
- **Conversation:** ↑/↓ and page keys scroll; Home jumps to the beginning and End follows
  the latest output. ←/→ switch agents. Enter opens a steer input, Ctrl+O expands tool
  output, and `o` brings a herdr-pi agent's Herdr pane to the front.
- **Either pane:** Tab switches focus; Esc closes the workspace. In a narrow terminal,
  Tab switches between full-width agent and conversation panes.

Messages and tool calls use Pi's own components and stream as they arrive. Saved runs
open in the same workspace with read-only conversations.

## Steer

In the detail view press Enter, type, and press Enter again: the message reaches the agent
before its next model request. Alt+Enter queues it as a follow-up instead. Every steer is
recorded, and the builder's reviewer is told about it.
Esc cancels a draft before closing the workspace. While typing, keys such as M and Space
belong to your message, and clicking another agent cannot redirect the draft.

## The live mascot

```text
/pinata live demo
```

A turning paper piñata with one ribbon per task sits beside the conversations. Space
bonks it, M toggles motion, and Esc returns to Pi. `/pinata live` shows your latest run;
`demo` previews the workspace with sample conversations and no model calls. Press D to
cycle demo scenes. Animation runs while an agent works or a brief reaction plays.

## A viewer in another terminal

Start the run's socket and follow it from anywhere on the same machine:

```text
/pinata watch
```

Then, in another terminal in the repository (_manual_):

```sh
pinata view
```

The viewer shows the same detail view, follows newly started agents, steers, and can
detach and attach again. Inside Herdr, `/pinata watch` opens it in a Herdr pane for you. In
`observe` mode the socket starts with every run.

For a finished run, `pinata view <run>` replays it from its log, and `pinata logs <run>`
prints it.
