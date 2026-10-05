# Pinata demo

`pinata-demo.mp4` is a real terminal recording from 2026-10-05, rendered from
Herdr's PTY output. The Pi coordinator and its scout, builder, and reviewer all
use OpenAI `gpt-6-luna`. The disposable project starts with a failing greeting
whitespace test; the accepted change is `name.trim()`. All three tests pass after
local integration, and all worker panes and worktrees are retired automatically.

The video trims startup and plays the run at 4× speed, with a final-frame hold.
Its header and stage captions are editorial annotations. `pinata-demo.gif` is a
short excerpt preview. Neither file is included in the npm package.

Capture: a 140×44 terminal attached to an isolated named Herdr session, with the
view following each live worker. Render: asciinema agg 1.9.0 and FFmpeg, H.264
with a web-compatible pixel format and fast-start metadata. No model responses
or terminal results were scripted.
