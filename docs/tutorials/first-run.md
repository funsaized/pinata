# First run

Install and reload Pinata, then ask Pi:

```text
Start two scouts: map the API and inspect its tests. Continue your own investigation
while they work, and bring back concrete files and open questions.
```

Discover definitions with `pinata_agents`. Use `pinata_run` for small assignments and
`background: true` when the coordinator has other work. Yield when waiting; completions
resume the coordinator. Use `pinata_status` for inspection or `pinata_wait` to wait for
selected work. Follow-ups reuse context and workspace; add more workers as needed.

Builders write directly to the shared checkout by default. Preserve unrelated edits and
run ordinary project checks. Select a worktree for experiments that should remain separate.
[Tools](../reference/tools.md) and [configuration](../reference/config.md) describe the API.
