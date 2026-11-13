# README media

The fleet screenshot, fleet video and navigation GIF were recorded on 2026-11-12
from a native Foot terminal. The fleet run used Piñata at `3270cbf`, the process
backend and `openai/gpt-6.1-sol` with low reasoning effort. Its nine workers include
two levels of delegation. The fleet video plays at 6× speed. Frames preserve
the full terminal without captions or simulated output.

All nine assignments in that run completed with confirmed cleanup and complete
reported usage.
The coordinator reran the generated CLI's 19 integration checks successfully. The
read-only reviewer found one large-number formatting defect in that demo CLI; the
recording does not establish coding-quality superiority or defect-free output.
Pi reported approximately $0.379 in model cost, which is usage evidence rather than
an invoice.

The navigation GIF comes from a separate live run at `18b1a77`, using the same
model and backend. It joins two navigation excerpts at normal speed and begins
with seven active workers, a completed scout and a queued reviewer. The activity
markers animate while work runs. All nine assignments completed with confirmed
cleanup and complete usage; Pi reported approximately $0.354 in model cost.

The source drivers, raw captures, earlier capture attempts, keyboard events, worker
results and cleanup evidence remain locally in
`bench/results/live-media-refresh-20261112/` and
`bench/results/live-media-animation-20261112/`. Those generated files are ignored by
Git. The live media runs are not performance comparisons.
