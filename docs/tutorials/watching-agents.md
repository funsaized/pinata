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

The detail view renders the agent's messages and tool calls with Pi's own components and
streams new text as it arrives. Keys: ↑/↓ and page keys scroll, ←/→ switch agents, Enter
opens a steer input, Ctrl+O expands tool output, Esc closes. For a herdr-pi agent, `o`
brings its Herdr pane to the front.

## Steer

In the detail view press Enter, type, and press Enter again: the message reaches the agent
before its next model request. Alt+Enter queues it as a follow-up instead. Every steer is
recorded, and the builder's reviewer is told about it.

## The live mascot

```text
/pinata live demo
```

A turning paper piñata with one ribbon per task. Space bonks it, M toggles motion, Esc
returns to Pi; `/pinata live` shows your latest run. It animates only while an agent works.

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
