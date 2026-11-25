# The Relay build

[![In Pi's fleet, relay-lead has two running children. The selected event-parser assignment asks for a parser and malformed-line tests. Its sibling is incident-stats.](pinata-fleet.png)](pinata-demo.mp4)

[Full build (2m 21s)](pinata-demo.mp4) · [Hero GIF (29s)](pinata-navigation.gif) · [Share the poster (PNG)](pinata-fleet.png)

| Time | What to watch                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00 | The shell lists the three project agents and shows that the lead's `handoffs` and the host's grant both name the two specialists.                                                                            |
| 0:22 | The user types the build request. When they submit it, `relay-lead` appears in the fleet and two running children branch beneath it.                                                                         |
| 0:53 | `incident-stats` writes `src/summarize.mjs` and runs its tests for failure counts and nearest-rank p95.                                                                                                      |
| 1:11 | `event-parser` corrects its date validation, then tests a malformed event between two valid lines. The test checks the line number and that both valid events survive.                                       |
| 1:21 | Back in the lead, the report is ready. The expanded `pinata_children` call shows both assignments. Its transcript also shows the writes to `src/render.mjs` and `bin/relay.mjs` and the child status checks. |
| 1:54 | The coordinator runs all ten tests, prints **4 events, 1 failure, 0 invalid lines**, and verifies the CLI output against the [supplied report](../examples/relay/expected-report.md) byte for byte.          |

## Rebuild the exports

Both cuts come from one live Pi 1.5.0 session in a standalone Foot window. The poster is the frame at 55s in the [source recording](relay/session.mp4).

Run the exporter from the Piñata checkout. It needs Python 3.10+ and FFmpeg with libx264.

```sh
python3 media/relay/export.py /tmp/relay-exports
```

## Record a fresh build

Get authorization for provider spend before submitting a live task. This take used OpenAI `gpt-6-luna`. From the Piñata checkout with dependencies installed, open a standalone Foot window with Bash. The take uses 104 columns and 39 rows, with 18 pt Operator Mono.

```sh
foot -T Relay -W 104x39 -f 'Operator Mono:style=Book:size=18' \
  -o 'font-bold=Operator Mono:style=Bold:size=18' \
  -o 'font-italic=Operator Mono:style=Book Italic:size=18' \
  -o 'font-bold-italic=Operator Mono:style=Bold Italic:size=18' \
  -o line-height=24 -o pad=42x32 bash --noprofile --norc -i
```

Prepare a new Relay checkout inside that window.

```sh
repo=$PWD
take=$(mktemp -d)
node examples/relay/setup.mjs "$take/Relay"
mkdir -p "$take/Relay/.pi/pinata"
cp -R examples/agents/relay "$take/Relay/.pi/pinata/agents"
cp examples/relay/recording/pinata.json "$take/Relay/.pi/"
printf '%s\n' '{"quietStartup":"header"}' > "$take/Relay/.pi/settings.json"
export PI_CODING_AGENT_DIR="$take/pi-agent"
mkdir -p "$PI_CODING_AGENT_DIR/pinata"
cp examples/relay/recording/grants.json "$PI_CODING_AGENT_DIR/pinata/"
cd "$take/Relay"
```

Configure the recording profile with the provider authentication, model settings and theme you use in Pi. Its [host grant](../examples/relay/recording/grants.json) allows one level of delegation to the two specialists. The [project config](../examples/relay/recording/pinata.json) gives the three workers a slot each.

On a wlroots desktop, run the following in a second terminal and select the whole Foot window. The original frame measures 1440 × 1360 pixels. Press Ctrl+C in the recorder after the verifier result has been on screen for several seconds.

```sh
wf-recorder -g "$(slurp)" --no-damage -r 12 -c libx264 -p crf=13 -x yuv420p -f relay-window.mkv
```

In the Relay window, show the [project definitions](../examples/agents/relay) and launch Pi with your terminal colors enabled.

```sh
ls -1 .pi/pinata/agents
grep '^handoffs' .pi/pinata/agents/relay-lead.md
jq -c '.delegation.agents' "$PI_CODING_AGENT_DIR/pinata/grants.json"
env -u NO_COLOR COLORTERM=truecolor PI_TELEMETRY=0 \
  "$repo/node_modules/.bin/pi" --offline --no-session --no-extensions --no-skills \
  --no-prompt-templates --no-context-files -e "$repo/engine/pi/extension.ts" \
  --model openai/gpt-6-luna --thinking medium
```

1. When Pi asks whether to trust the new starter, select it. Type the request below and hold it on screen before pressing Enter.
2. Press Shift+Down for the fleet. Hold on the expanded tree, then select a child and press Enter. Shift+Left and Shift+Right switch between workers. In the lead's conversation, press Tab to focus the transcript and use the arrow keys to scroll back to its tool calls.
3. Return to the coordinator. Run `!node --test --test-reporter=spec`, `!node bin/relay.mjs data/events.jsonl` and `!node verify.mjs`.

```text
@relay-lead Build an incident report from data/events.jsonl. Give parsing and service statistics to your specialists, wire their work into the CLI, and show me the report.
```
