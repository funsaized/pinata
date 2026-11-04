# Choose a mode

Keep the default `lean` mode for everyday work. Choose `observe` when you want a
live external viewer and more detail saved for later inspection:

```text
/pinata mode observe
```

|                | `lean` (default)                     | `observe`                                      |
| -------------- | ------------------------------------ | ---------------------------------------------- |
| Run log        | lifecycle events, usage, results     | every event, including text deltas and tools   |
| Transcripts    | written when each agent finishes     | written live                                   |
| Socket         | started on `/pinata view --external` | started with the run                           |
| Telemetry      | tokens and cost                      | plus memory, event-loop use and lag, every 2 s |
| Widget refresh | at most 4/s                          | at most 10/s                                   |

The command changes the mode for the rest of the Pi session. To save a default,
set `mode` in your personal or repository [configuration](../reference/config.md),
or use a run's `config` for a single job. See [watching agents](../tutorials/watching-agents.md)
to open the viewer.
