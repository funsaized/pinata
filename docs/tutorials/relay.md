# Build Relay

Relay is a small Node CLI that reads event records, summarizes them and renders a
Markdown report. It exercises parallel modules and a dependent integration step.
The example leaves review and acceptance with the coordinator.

Create a new disposable checkout. Setup refuses an existing destination and makes
no model calls:

```sh
node examples/relay/setup.mjs /tmp/relay-exercise
cd /tmp/relay-exercise
```

Read `REQUIREMENTS.md`. The starter intentionally contains unfinished module stubs;
`node verify.mjs` fails until those are implemented. Set the three model entries in
`job.json` to providers/models you have approved and can access. Running the job
spends tokens.

```sh
pinata run job.json --workspace . --watch --json
```

One scout maps interfaces, then parser, summarizer and renderer builders work in
parallel on the shared checkout. A CLI builder waits for those exact assignments
and integrates their modules. A reviewer reads the result and reports findings.
Those are ordinary definition choices in the example, not built-in orchestration
roles or mandatory review gates.

The coordinator now runs:

```sh
node --test
node verify.mjs
git diff
```

Inspect failures and send targeted follow-ups. A failed test does not hide a worker's
changes, restart completed workers or prevent a new assignment. `after` controls
ordering; it does not mean a predecessor passed review. Use a live `serve` host if
you want to continue controlling the run from other terminals.

The expected report and verifier are independent example inputs. Preserve them
while repairing the implementation. Shared work needs no application step and
Pinata does not make automatic commits in this checkout. The offline regression
uses scripted file writes from a retained reference fixture; it verifies this
workflow and the example oracle, not model coding quality.
