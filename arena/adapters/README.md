# Adapter implementation boundary

`offline.ts` implements deterministic harness controls. It does not invoke Piñata,
Pi, OpenCode, or any model. All offline usage is known zero and labeled scripted.
The controls are `known-good`, `noop`, `broken`, and `repair-control`.

Each unit builds in a separate copied directory containing candidate files only.
Sequential units receive preceding staged changes. Parallel units start from the
same candidate snapshot and execute concurrently. File ownership and preimages
are checked before final integration into the candidate. The copied directories,
builder outputs before repair, handoffs, reviews, repair records, and event log remain under `evidenceDir/offline`
on successful and failed runs. Copies omit Git metadata; these directories are
evaluation isolation, not security sandboxes.

Review is a scripted comparison to controller-owned reference files. Only
`repair-control` repairs differences, and only when the workflow includes review
and the repair budget is positive. It plants a defect in the first unit and gives
the reviewer the reference solution. This deliberately artificial advantage tests
repair plumbing; it must be grouped separately and cannot establish reviewer
capability or workflow superiority. `broken` retains the same planted defect even
with review. `noop` makes no edits. `known-good` copies owned reference files.
Adapter completion reports execution success; the runner's external oracle
separately reports candidate correctness.

## External commands

The three `*.example.json` files are **unverified configuration templates** with
placeholder wrapper paths. They are not usable Piñata/Pi/OpenCode integrations, were not
live tested, and contain no model or provider defaults. An operator must implement
and validate the corresponding framework wrapper and explicitly opt into external
execution through the runner.

The runner accepts `{ name, command, args?, model?, timeoutMs? }`, writes a public
`AdapterRequest` to an absolute JSON path, and appends that path to `args`. The
command is launched with `shell: false` and bounded by runner limits. The request
contains the candidate directory, prompt, unit ownership, workflow, limits,
starting revision, model configuration, and evidence destination. It excludes
the trusted oracle and reference solution paths.

The command must emit exactly one JSON `AdapterResponse` to stdout, exit nonzero
on invocation failure, and preserve useful raw evidence under `evidenceDir`.
Send logs to stderr or evidence files. Report actual framework/model versions,
settings, stage events, attempts, repairs, and measured usage. Use `null` for
unavailable usage or cost; never turn missing telemetry into zero. Honor the
requested workflow and repair budget or fail explicitly. The runner retains the
raw stdout/stderr and validates the response.

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

External adapters can run arbitrary local code and may spend money when configured
with provider credentials. No live framework or paid model validation is part of
the offline pilot.
