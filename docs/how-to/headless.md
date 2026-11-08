# Headless jobs

## Write a job file

```json
{
  "schemaVersion": 3,
  "cwd": ".",
  "workspace": "shared",
  "tasks": [
    {
      "id": "build",
      "agent": "builder",
      "task": "Implement the assigned feature and report actual checks."
    }
  ]
}
```

```sh
pinata run job.json --json
pinata logs <run> --follow
pinata view <run>
```

Paths resolve relative to the job file when `cwd` is given. The same host and engine
power interactive and headless work. Shared is the default, including non-Git directories.
A job with `run: "<existing-run-id>"` adds its new workers to that saved run;
existing workers and assignments are preserved.
Shared edits are already delivered. Isolated jobs may choose `integration: "apply"` as an
explicit separate application action after execution; the default is `manual`.
`--no-apply` preserves manual delivery. `pinata integrate <run>` applies saved isolated
snapshots later without starting a model. It makes no quality claim.

Exit codes describe execution: 0 completed, 1 process/preparation/application failure,
2 invalid input, 3 cancellation. A worker reporting a failed test does not by itself make
execution fail. The coordinator or external CI must assess correctness.
`pinata resume <run>` reattaches current-format recoverable work; legacy runs remain read-only.
