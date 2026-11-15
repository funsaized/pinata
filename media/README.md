# README media

The screenshot, navigation GIF and MP4 demo were recorded on 2026-11-15 from the
fleet UI in Pi 1.5.0, using an isolated offline PTY at 160 columns by 38 rows. Eight
scripted assignments demonstrate the inspector, tree, filters, conversation and
project run picker. The second run demonstrates saved, read-only browsing.

These are UI demonstrations, not live model results or coding-quality evidence.
The capture rejects provider requests and made zero model calls. PNG frames
rasterize the exact ANSI rows returned to Pi, using Adwaita Mono and the Piñata
palette. The GIF and MP4 play the same 40-second sequence at its original speed,
with four frames per second. No captions or generated UI elements were added.

To reproduce on Linux, install Python with Pillow, fontconfig, Adwaita Mono and
FFmpeg, then run:

```sh
python3 test/readiness/fleet-demo.py --root "$PWD" \
  --out bench/results/fleet-media-unique \
  --pi node "$PWD/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
```

The driver retains raw PTY bytes, timed keyboard and render events, PNG frames and
encoded media. The published capture is retained locally in
`bench/results/fleet-media-publish-20261115/`; earlier attempts from this refresh
remain beside it. Generated evidence is ignored by Git. The checked-in drivers
reproduce the workflow without credentials.
