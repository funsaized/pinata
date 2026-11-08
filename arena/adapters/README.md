# Adapter implementation boundary

`offline.ts` implements deterministic harness controls. It invokes no model or
Piñata, Pi, or Codex framework. All offline usage is known zero and labeled
scripted. This is a copied-reference plumbing pilot, not a live coding comparison.
The controls are `known-good`, `noop`, `broken`, and `repair-control`.

Each unit builds in a separate copied directory containing candidate files only.
Sequential units receive preceding staged changes. Parallel units start from the
same candidate snapshot and execute concurrently. File ownership and preimages
are checked before final integration into the candidate. Copied directories,
builder outputs before repair, handoffs, reviews, repair records, and event logs
remain under `evidenceDir/offline` on successful and failed runs. Copies omit Git
metadata; they are evaluation isolation, not security sandboxes.

Review is a scripted comparison to controller-owned reference files. Only
`repair-control` repairs differences, and only when the workflow includes review
and the repair budget is positive. It plants a defect in the first unit and gives
the reviewer the reference solution. This artificial advantage tests repair
plumbing; it cannot establish reviewer capability or workflow superiority.
`broken` retains the same planted defect even with review. `noop` makes no edits.
`known-good` copies owned reference files. Adapter completion reports execution
success; the oracle separately reports candidate correctness.

## External commands

The two `*.example.json` files are **unverified configuration templates** with
placeholder wrapper paths. They are not usable Piñata or Pi
integrations and were not live tested. An operator must implement and validate
each framework wrapper and explicitly opt into external execution through the
runner.

The runner accepts `{ name, command, args?, model?, timeoutMs? }`, writes a public
`AdapterRequest` to an absolute JSON path, and appends that path to `args`. The
command is launched with `shell: false` and bounded by runner limits. The request
contains the candidate directory, prompt, unit ownership, workflow, limits,
starting revision, model configuration, and evidence destination. It excludes
the trusted oracle and reference solution paths.

The command must emit exactly one JSON `AdapterResponse` to stdout, exit nonzero
on invocation failure, and preserve useful raw evidence under `evidenceDir`.
Send logs to stderr or evidence files. Report actual framework and model versions,
settings, stage events, attempts, repairs, and measured usage. Use `null` for
unavailable usage or cost; never turn missing telemetry into zero. Honor the
requested workflow and repair budget or fail explicitly. The runner retains the
raw stdout and stderr and validates the response format.

These reports are adapter self-reports. A valid response and an oracle pass do
not verify that the requested sequential or parallel stages, review, or repair
budget were enforced. All current external adapters are unverified and excluded
from treatment comparisons until trusted supervisor stage evidence exists and is
validated. Correctness and treatment verification are separate questions.

`protocol.ts` exports `readAdapterRequest(path)` and `runProtocol(handler)` for
wrapper authors. `runProtocol` reads the one positional argument and serializes
the handler response; it supplies no framework integration. For example:

```ts
import { runProtocol } from "/absolute/path/to/arena/adapters/protocol.ts";

await runProtocol(async (request) => {
  // Implement and verify a real framework invocation here. Do not synthesize
  // model activity, usage, review stages, or successful completion.
  throw new Error(`Framework integration not implemented for ${request.workflow}`);
});
```

A usable live adapter still needs framework invocation and version/configuration
capture, trusted supervisor evidence for stage ordering, parallel execution,
review and repair limits, full dependency provenance, usage accounting, and
isolation appropriate for untrusted code. Any paid validation requires a later,
explicitly approved plan. External commands can run arbitrary local code and may
spend money when configured with provider credentials. No live framework or paid
model validation is part of this pilot.

## Native local pilot

`native.ts` provides whole-task coordinator adapters for Codex, plain Pi (solo),
and Piñata. They use the `native` workflow and remain unverified. Piñata explicitly
loads this checkout's extension. Its coordinator has ordinary coding tools and
can finish shared work directly or explicitly apply isolated changes. Completion
reports process execution; the oracle scores delivered files independently.
Delegation is retained as separate evidence, not a prerequisite for correctness.

Run `npm run arena:bootstrap`, `npm run arena:doctor`, then `npm run arena:local`
for the terminal wizard. Use `npm run arena:local -- --preview` to inspect the
plan-and-execute prompt without any model calls. See the
[local pilot guide](../../docs/maintainers/coding-arena.md#local-native-system-pilot-codex-piñata-and-pi)
for configuration, evidence, project requirements and comparison limitations.

Pinata native trials accept `model.settings.backend` (`in-process`, `process`,
`herdr-pi`) and `model.settings.workspace` (`shared`, `worktree`) in the local
adapter config. Defaults remain in-process/shared. Use a distinct adapter name
for each treatment and preview before running. These settings instruct the
coordinator; inspect actual worker events/configuration to verify adherence.
Detached lifetime is a separate experiment: the native pilot uses `survive:false`.
Bootstrap overwrites local configs. No additional live modes have been validated.
