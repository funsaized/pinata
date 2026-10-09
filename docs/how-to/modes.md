# Choose a mode

pinata has two footprint modes. Choose with `mode` in [configuration](../reference/config.md)
(per user, per repository or per run) or for the rest of the session:

```text
/pinata mode observe
```

|                | `lean` (default)                 | `observe`                                      |
| -------------- | -------------------------------- | ---------------------------------------------- |
| Run log        | lifecycle events, usage, results | every event, including text deltas and tools   |
| Transcripts    | written when each agent finishes | written live                                   |
| Socket         | started on `/pinata watch`       | started with the run                           |
| Telemetry      | tokens and cost                  | plus memory, event-loop use and lag, every 2 s |
| Widget refresh | at most 4/s                      | at most 10/s                                   |

Use `observe` when you want to follow a run from another terminal or study it afterwards;
its overhead is small (measured: CPU +0–6%, same wall time). Use `lean` otherwise.
