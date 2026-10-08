# Watch the live mascot

Try the mascot's controls, then watch a small subagent session from Pi.
You need pinata loaded in interactive Pi. The real-agent step also needs
[working Herdr and model setup](../setup.md).

## 1. Try it without starting agents

After updating pinata, start a fresh Pi session. Then enter:

```text
/pinata live demo
```

The **DEMO** label means the task names are examples. No agents start, no run is
saved, and no model calls are made. Press Space to bonk the hanging piñata.
Press D several times to see the scout, builder, review, waiting-for-integration,
success, and rejected-review scenes. The success transition throws confetti.
Press M for static art, and Esc to close.

## 2. Start two scouts

In a repository you want to explore, give Pi this prompt:

```text
Use pinata to run two scouts in parallel. Have one explain how this project's
main entry point reaches its core behavior. Have the other identify the most
relevant tests and how to run them. Each scout should give three concrete
findings with file and line references. Keep this read-only; do not change
files. Start the run, yield while it works, then combine the findings.
```

These are real agents using your configured model and normal model budget.
After Pi starts them and yields, enter:

```text
/pinata live
```

The scene now shows the saved run ID and actual tasks. Their colored markers
match the ribbons around the mascot. Watch the statuses change as the workers
start and finish. Space still bonks; the workers continue undisturbed.

Scouts do not produce builder changes, so all scouts succeeding is enough for
the celebration. For a builder-and-review run, it waits until integration is
verified. If Pi needs your input, press Esc to return to the conversation.

## 3. Inspect the result

Close the scene with Esc and let Pi present the combined findings. Use `/pinata`
for a status card, `/pinata runs` for history, or `/pinata live <run-id-prefix>`
to inspect a particular run again. Left and Right switch among the runs loaded
in the live view; Up and Down scroll long task lists.

Use `/pinata motion off` to keep the mascot still for the session, including
after `/reload`. `/pinata motion on` restores animation. Start a new Pi with
`PINATA_MOTION=off` if you prefer static art by default.

---

Part of the [pinata documentation](../README.md). Next: [build and review a change](build-and-review.md).
