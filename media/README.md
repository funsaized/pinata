# README media

The fleet screenshot, fleet video and navigation GIF were recorded on 2026-11-12
from a native Foot terminal. The fleet run used Piñata at `3270cbf`, the process
backend and `openai/gpt-6.1-sol` with low reasoning effort. Its nine workers include
two levels of delegation. The fleet video plays at 6× speed. The navigation GIF
shows the same run in the saved, read-only viewer at normal speed. Frames preserve
the full terminal without captions or simulated output.

All nine assignments completed with confirmed cleanup and complete reported usage.
The coordinator reran the generated CLI's 19 integration checks successfully. The
read-only reviewer found one large-number formatting defect in that demo CLI; the
recording does not establish coding-quality superiority or defect-free output.
Pi reported approximately $0.379 in model cost, which is usage evidence rather than
an invoice.

The source driver, raw captures, earlier capture attempts, keyboard events, worker
results and cleanup evidence remain locally in
`bench/results/live-media-refresh-20261112/`. Those generated files are ignored by
Git. The separate [performance report](../docs/performance-followups.md) contains
matched scripted measurements; the live media run is not a performance comparison.
