# v2 performance evidence

Captured on Linux x64, 2026-10-30, with Node 26.7.0 and Pi 1.4.0 (Bun 1.3.14).
These are local faux-provider measurements of engine overhead. They do not measure
model quality, remote-provider latency, or production throughput.

The v1.1.0 baseline is commit `7aec388`; v2 uses resolved definitions. Both ran the
default scenarios on the same machine. Raw reports are committed under `bench/baselines`:
`1.1.0-linux-node.json`, `2.0.0-linux-node.json`, `2.0.0-linux-pi.json`, and
`2.0.0-linux-scale.json`.

| Measurement                                | v1.1 / Node | v2 / Node | v2 / Pi binary |
| ------------------------------------------ | ----------: | --------: | -------------: |
| 8-task first request, median               |    6.397 ms |  7.079 ms |       6.876 ms |
| 64-task session setup, median              |    1.685 ms |  2.035 ms |       3.370 ms |
| 64-task peak RSS increase per active agent |     0.45 MB |   0.44 MB |        1.29 MB |
| Mixed-work dependency dispatch, p99        |    0.041 ms |  0.051 ms |       0.168 ms |
| Streaming UX event-loop lag, p99           |     3.03 ms |   3.06 ms |       10.54 ms |

The default suites passed the existing CI gates without changing budgets. Those gates
allow 2× their target values to accommodate shared runners. Follow-up comparisons were
noisy on both paths, so these samples do not establish statistical equivalence or zero
overhead. The v2 Node sample adds about 0.35 ms to median setup at 64 tasks. RSS deltas
depend on allocation and GC history; a zero delta does not mean a session uses no memory.

## Scale scenarios

All three scenarios succeeded with a maximum of 64 active agents. They use immediate
faux responses, keeping provider work out of the measurement.

| Scenario                           | Tasks completed | Wall time | Heap retained after GC |
| ---------------------------------- | --------------: | --------: | ---------------------: |
| Queued fan-out                     |           1,000 |  2,783 ms |               26.57 MB |
| 256 predecessors and one dependent |             257 |    736 ms |                5.95 MB |
| Eight dependent batches of 64      |             512 |  1,367 ms |               11.40 MB |

Retained heap includes run history, results, runtime caches, and measurement state. It
is measured while the host still retains the run; it is not a leak estimate or a promise
of constant memory for unlimited history. Separate tests cover fairness across runs,
cancelled worktree preparation, compact-result pagination, and dependency context bounds.

See [testing](testing.md) for reproducible commands. Repeat comparisons on a quiet host
before drawing conclusions from small differences.
