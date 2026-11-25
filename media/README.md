# The Relay build

[![The live Relay fleet with relay-lead above its two running children. The selected event-parser assignment asks for src/parse.mjs and malformed-line tests.](pinata-fleet.png)](pinata-demo.mp4)

[Watch the full build (2m 23s)](pinata-demo.mp4) · [Watch the short cut (29s)](pinata-navigation.gif) · [Share image (PNG)](pinata-fleet.png)

| In the full build | What to look for                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00              | Three Markdown files live in the project. The lead's `handoffs` lists `event-parser` and `incident-stats`.                                                                                                                            |
| 0:09              | The user addresses `@relay-lead` in Pi. The lead calls `pinata_children`, and the fleet branches beneath it.                                                                                                                          |
| 0:50              | `event-parser` writes the parser. In the other branch, `incident-stats` tests the 5xx boundary and nearest-rank p95. Its first integration check reaches the unfinished parser. Once the parser is in, a follow-up checks the sample. |
| 1:26              | The parser test keeps the valid events on either side of a malformed line. Back in the lead's transcript, the renderer and CLI writes sit beside the child result checks.                                                             |
| 1:51              | The coordinator runs all 11 tests, prints **4 events, 1 failure, 0 invalid lines**, then runs `node verify.mjs`. The output matches the [supplied report](../examples/relay/expected-report.md) byte for byte.                        |

## Rebuild the exports

Both cuts use one live Pi 1.5.0 terminal session with OpenAI `gpt-6-luna`. The clock in the caption is time since recording started. A cut shows how much time it skips. The short cut crops the terminal around the action. The poster is a crop of the fleet at 1m 50s.

The source recording contains the terminal output and its timing. [Download the compressed asciicast](relay/session.cast.gz).

The exporter uses `agg` 1.9.0, Adwaita Mono, `fontconfig`, FFmpeg with libx264, and Python 3.10+ with Pillow. Run it from the Piñata checkout with a new output directory.

```sh
python3 media/relay/export.py /tmp/relay-exports
```

## Record a fresh build

A new take spends provider tokens. Get authorization for the provider and model before submitting the task. The following Linux setup uses the repository's installed Pi dependency and records output and timing with util-linux `script`. Start in the Piñata checkout with an 86-column, 27-row terminal.

```sh
repo=$PWD
take=$(mktemp -d)
node examples/relay/setup.mjs "$take/Relay"
mkdir -p "$take/Relay/.pi/pinata"
cp -R examples/agents/relay "$take/Relay/.pi/pinata/agents"
cp examples/relay/recording/pinata.json "$take/Relay/.pi/"
node -e 'console.log("/pinata-grants " + JSON.stringify(require("./examples/relay/recording/grants.json")))'

cd "$take/Relay"
TERM=xterm-256color COLORTERM=truecolor NO_COLOR=1 PI_TELEMETRY=0 \
  script -qef -O "$take/terminal.log" -T "$take/terminal.time" -- \
  "$repo/node_modules/.bin/pi" --offline --no-session --no-extensions --no-skills \
  --no-prompt-templates --no-themes --no-context-files -e "$repo/engine/pi/extension.ts" \
  --model openai/gpt-6-luna --thinking medium
```

In Pi, submit the printed `/pinata-grants` command, then `/pinata-new`. The [host grant](../examples/relay/recording/grants.json) allows one level of delegation to the two named specialists in the shared workspace. The [project config](../examples/relay/recording/pinata.json) gives the three workers room to run together. Pi's `--offline` skips startup network operations. Submitting the assignment contacts the provider.

1. Show the [definitions](../examples/agents/relay) in Pi with `!ls -1 .pi/pinata/agents` and `!grep '^handoffs' .pi/pinata/agents/relay-lead.md`.
2. Type the request below. Hold it on screen before pressing Enter.
3. Press Shift+Down to open the fleet. When both children appear, hold on the tree, select a child and press Enter. Shift+Left and Shift+Right switch workers. Page Up shows earlier edits and test results.
4. Return to the lead for integration. Back at the Pi composer, run `!node --test --test-reporter=spec`, `!node bin/relay.mjs data/events.jsonl` and `!node verify.mjs`. Keep the report and verifier result on screen before closing Pi.

```text
@relay-lead Build an incident report from data/events.jsonl. Give parsing and service statistics to your specialists, wire their work into the CLI, and show me the report.
```
