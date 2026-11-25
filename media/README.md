# The Relay build

[![Pi’s fleet in a Foot terminal. Under relay-lead, event-parser and incident-stats are both running. The selected parser assignment asks it to implement src/parse.mjs and test malformed lines.](pinata-fleet.png)](pinata-demo.mp4)

[Watch the full build (2m 13s)](pinata-demo.mp4) · [Watch the hero GIF (29s)](pinata-navigation.gif) · [Share the poster (PNG)](pinata-fleet.png)

| Time in the full build | What happens in Pi                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00                   | The terminal lists the project's three Markdown files. The lead's `handoffs` names both specialists.                                                                                                                                               |
| 0:22                   | The user types `@relay-lead` in the composer. The fleet opens on the lead, then two running children appear beneath it.                                                                                                                            |
| 0:50                   | The selected parser assignment names its file and tests. In the other branch, `incident-stats` writes `src/summarize.mjs` and checks which statuses count as failures and how to calculate p95 latency.                                            |
| 1:08                   | In `event-parser`, the test output shows that valid events on either side of a malformed line survive.                                                                                                                                             |
| 1:17                   | Back in `relay-lead`, the transcript shows its `pinata_children` call, the renderer and CLI writes, and its checks on the children's results.                                                                                                      |
| 1:50                   | The coordinator runs all nine tests and prints the report. The four events include one failed API request and no invalid lines. `node verify.mjs` checks stdout against the [supplied report](../examples/relay/expected-report.md) byte for byte. |

## Rebuild the exports

Both cuts show the same Foot window running Herdr and Pi 1.5.0 on Wayland. The recording retains the window frame, sidebar, Gruvbox colors and Operator Mono lettering. A small label in the sidebar gives the time skipped at each cut. The poster is the full frame at 1m 54s. The final verifier shot holds a compositor screenshot from the same session. [Download the source recording (MP4)](relay/session.mp4).

Run the exporter from the Piñata checkout. It needs Python 3.10+, FFmpeg with libx264 and drawtext, and DejaVu Sans for the elapsed-time labels.

```sh
python3 media/relay/export.py /tmp/relay-exports
```

## Record a fresh build

Get authorization for provider spend before submitting a live task. This take used OpenAI `gpt-6-luna`. Start in a Foot terminal running Herdr, in the Piñata checkout with dependencies installed.

```sh
repo=$PWD
take=$(mktemp -d)
node examples/relay/setup.mjs "$take/Relay"
mkdir -p "$take/Relay/.pi/pinata"
cp -R examples/agents/relay "$take/Relay/.pi/pinata/agents"
cp examples/relay/recording/pinata.json "$take/Relay/.pi/"
node -e 'console.log("/pinata-grants " + JSON.stringify(require("./examples/relay/recording/grants.json")))'
cd "$take/Relay"
```

Give the window 1280 × 850 pixels and use 15 pt terminal text. On a wlroots desktop, run the following in a second terminal and select the whole Foot window, including its border. Press Ctrl+C in the recorder after the verifier result has been on screen for several seconds.

```sh
wf-recorder -g "$(slurp)" --no-damage -r 12 -c libx264 -p crf=13 -x yuv420p -f relay-window.mkv
```

In the Relay window, show the [project definitions](../examples/agents/relay) and launch Pi with your terminal colors enabled.

```sh
ls -1 .pi/pinata/agents
grep '^handoffs' .pi/pinata/agents/relay-lead.md
env -u NO_COLOR COLORTERM=truecolor PI_TELEMETRY=0 \
  "$repo/node_modules/.bin/pi" --offline --no-session --no-extensions --no-skills \
  --no-prompt-templates --no-context-files -e "$repo/engine/pi/extension.ts" \
  --model openai/gpt-6-luna --thinking medium
```

1. Submit the printed `/pinata-grants` command, then `/pinata-new`. The [host grant](../examples/relay/recording/grants.json) allows the lead to delegate one level to its two specialists in the shared checkout. The [project config](../examples/relay/recording/pinata.json) gives all three workers a slot. See the [nested-delegation example](../README.md#nested-delegation).
2. Show the input with `!cat data/events.jsonl`. Type the request below in Pi and hold it on screen before pressing Enter.
3. Press Shift+Down for the fleet. Hold on the expanded tree, then select a child and press Enter. Shift+Left and Shift+Right switch between workers. In the lead's conversation, press Tab to focus the transcript and use the arrow keys to scroll back to its tool calls.
4. Return to the coordinator. Run `!node --test --test-reporter=spec`, `!node bin/relay.mjs data/events.jsonl` and `!node verify.mjs`.

```text
@relay-lead Build an incident report from data/events.jsonl. Give parsing and service statistics to your specialists, wire their work into the CLI, and show me the report.
```
