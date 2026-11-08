# Jobs and assignments

Use ordinary delegation with shared edits by default. Discover definitions with
`pinata_agents`, assign responsibilities in task text, and choose tests/review in the
coordinator. A job is a tasks array plus optional workspace/config/instructions.
See [headless jobs](../docs/how-to/headless.md).

A shared implementation assignment:

```json
{
  "id": "api",
  "agent": "builder",
  "task": "Implement the API and its regression tests in src/api.ts and test/api.test.ts. Preserve unrelated edits and report actual checks."
}
```

An isolated experiment:

```json
{
  "id": "alternative",
  "agent": "builder",
  "workspace": "worktree",
  "task": "Explore an alternative parser. Leave the experiment isolated for coordinator inspection."
}
```

Use `after` to order accepted assignments. Add workers to the existing run and send
follow-ups as the plan changes. Dependencies do not require tests or review approval;
`inputs` explicitly composes isolated snapshots. Shared edits need no apply step.

The coordinator can run project commands, ask for review, assess findings, reconcile
changes and finish. Completion and correctness are distinct. Pinata has no production
resource quotas or mandatory ownership declarations. [Migration](../docs/reference/migration.md)
converts older jobs without silently retaining enforcement claims.

Examples: [small job](job.json), [scouts](scout-job.json),
[parallel builders](jobs/parallel-builders-job.json), [Relay](relay/job.json).
Choose available models and actual authorized scope before running examples with paid calls.
