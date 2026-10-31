# Container adapter contract, v1

The runner executes a pinned local container image and an argument array. It never
runs a contestant command on the host. `live` requires `--allow-provider-spend` even
when the adapter claims its provider is free. This flag is operator consent, not a
hard spending guarantee. Only the isolated mock provider is called by tests.

**Bundled status:** executable wrappers for patched Piñata 2.0.1 + Pi 1.4.0,
OpenCode 2.2.5 native subagents, and Pi 1.4.0's **official subagent example
extension**. All three are exercised using their actual CLIs and a separate
scripted OpenAI-compatible HTTP provider. The mock audit verifies every request's
usage against the attempt ledger, including parent, three children and OpenCode
auxiliary requests. This is offline conformance, **not a live model evaluation or
an invoice calibration**. The simpler `demo` still uses the same FakeBackend in
all three lanes and is labelled separately.

Commands on this page are _manual_ operator walkthroughs. The mock path needs no
provider credentials. Do not run the live command without authorization for spend.

## Build and rehearse

Prerequisites: Node >=22.19, local Linux x64 Docker daemon at
`/var/run/docker.sock`, network access for setup, and disk space for the image.
The setup currently supports Linux x64 only. It uses the immutable verifier base,
a locked npm dependency graph, and the official OpenCode release with SHA-256 in
[versions.json](versions.json). It never runs an install script from a contestant.
OS packages are resolved at build time; the resulting immutable image id, actual
Piñata source hashes and adapter hashes are recorded in the build artifact.

```sh
npm run arena:setup
node examples/arena/adapters/build.mjs --out /tmp/arena-image.json
# Optional verified local release cache: --archive /path/opencode-linux-x64.tar.gz
node examples/arena/adapters/mock-run.mjs --image-file /tmp/arena-image.json \
  --out /tmp/arena-cli-rehearsal
node examples/arena/cli.ts serve --dir /tmp/arena-cli-rehearsal
```

The mock network is internal, with no route to external providers and no credentials.
Only its provider container has canned tool responses; the contestant image has no
fixtures, private grader or expected answers. A smoke check rejects those paths.
The generation container sees a private starter Git repository, completes its
children, verifies protected files, then exports only the allowed candidate.
Its process/session metadata lives outside the exported source tree.

## Metering and supported configurations

`run.mjs` supports the standard **OpenAI-compatible chat-completions API**. It is
not a universal adapter for every native provider/authentication scheme. The same
explicit model is configured in all three CLIs, with thinking off, 32K context and
8K output limits. Pi's retry and automatic compaction are disabled for this initial
controlled setup. Piñata uses its real process backend and isolated builder worktree;
OpenCode uses native subagents sharing its private outer checkout; the Pi example
uses the shipped scout/worker/reviewer definitions. The parent must integrate and
verify before finishing. These prompts/configurations are part of the contestant.

For `controlled-same-model`, the official example's `model:` frontmatter is removed
so children inherit the explicit selected model. In `practical-defaults` it is
preserved; the stock child models require their own supported credentials and
pricing. That mode must be configured and calibrated separately; one custom
endpoint cannot automatically supply every stock provider. Any observed model
mismatch is recorded, and no missing child cost is treated as zero.

Pi parent JSON events, Piñata per-attempt journals, the example's telemetry extension,
and authenticated OpenCode session exports capture model ids, turns, tools and
outcomes. A local proxy observes usage metadata from **every request to the configured
endpoint**, including calls missing from session exports. Exact token/cache/model
matching prevents double counting; unmatched residual requests become parent
overhead. Missing usage, interrupted calls or inconsistent snapshots make the
aggregate unknown. Prompts, answers, credentials and HTTP headers are not retained
by that proxy. It preserves the environment's HTTP proxy/CA configuration. Requests
to another provider endpoint are outside that reconciliation boundary; unsupported
native billing/compaction formats must remain unknown. The pure normalizer tests
exercise retries, conflicts and missing metadata; no claim is made that live
provider compaction has been calibrated.

A price is an estimate from an operator-supplied dated rate card, not the SDK's
often-zero default cost. Optional `pricing` has nonnegative USD-per-million
`input`, `output`, `cacheRead`, `cacheWrite`, plus `reference` and ISO `at`; optional
`prices` maps actual `provider/model` ids to such objects. Unknown child rates stay
null. Reasoning tokens are included in output and recorded separately when supplied.
Mock prices are always marked synthetic.

## Inputs and lifecycle

The container sees only:

- `/work`: a fresh writable starter copied from the task's public files;
- `/arena/input.json`: read-only public prompt, attempt id, track, requested model,
  entry filename, and limits;
- the pinned image's own filesystem and a bounded temporary filesystem.

The adapter must put its final implementation in `/work/solution.mjs` (or the task's
entry), keep caches/sessions elsewhere, stop all child sessions, then emit one terminal
event and exit. The runner waits for container removal before freezing the allowed
files. Terminal alone does not stop the clock: descendants and late protocol events
must be done. Exit without terminal, nonzero exit, malformed events, excess output,
conflicting receipts, timeout and cancellation all fail the attempt. No graded
feedback is returned. All retries within the attempt remain on its bill.

Read `/arena/input.json` inside the container. Send **only JSONL protocol events** to
stdout; send diagnostics to stderr. Both streams share a bounded output allowance.
Secrets named in the config are passed explicitly with Docker `-e NAME`; their
values are never saved in the manifest. Keep secrets out of diagnostics and events.
The run directory is private, and the viewer serves only normalized events and
explicit final patches. Inspect/redact artifacts before sharing them.

## Events

The executable validation is [protocol.ts](../protocol.ts). Each line is one of:

```json
{"type":"session-open","id":"parent","parent":null,"role":"parent","model":{"provider":"provider","id":"actual-model"}}
{"type":"phase","session":"parent","phase":"planning","detail":"Delegating work"}
{"type":"session-open","id":"build-1","parent":"parent","role":"builder","model":{"provider":"provider","id":"actual-child-model"}}
{"type":"usage","id":"build-1/message-1","session":"build-1","kind":"message","model":{"provider":"provider","id":"actual-child-model"},"meters":{"input":100,"output":20,"cacheRead":30,"cacheWrite":0,"totalTokens":150,"turns":1,"toolCalls":2,"costUsd":null},"pricing":{"source":"unknown","reference":"Provider did not return dollar cost; no estimate configured","at":"2026-10-31T00:00:00Z"}}
{"type":"session-close","id":"build-1","usageComplete":true}
{"type":"session-close","id":"parent","usageComplete":false}
{"type":"terminal","status":"completed","reason":"All children stopped; candidate ready"}
```

Session ids are unique within an outer attempt. Open parents before children. Report
the **actual** provider/model for each session and each receipt, including model
changes. Controlled-track mismatches make the attempt explicitly incomparable.
Use separate sessions for retry launches; each may use a unique role such as
`builder-retry`. Compaction receipts use `kind: "compaction"`; parent planning,
review, integration, failed calls and overhead are billable too.

Receipts are incremental, never cumulative snapshots. Their ids must remain stable
across retransmission. Exact duplicate deliveries count once; conflicting duplicate
ids fail the attempt. Sum all message/retry/compaction/overhead receipts. Do not emit
a second aggregate settlement receipt for messages already reported. In particular,
Piñata `agent_settled` describes an attempt, while its repaired `RunView` includes
all attempts: **never sum both**. Choose one complete receipt source and record it.

Every meter may be null; null means unknown, including unknown cost under a
subscription. `0` is an explicit observed zero. `usageComplete` attests that every
billable message for that session was captured; it does not manufacture missing
meters. An open/incomplete/unreported session makes totals unknown. Known receipts
remain visible as a partial sum. A complete session needs at least one receipt;
report an explicit zero receipt if the provider actually observed zero work.

Pricing `source` is `provider`, `estimate`, `unknown`, or `fixture`. Record the source
URL/receipt reference, retrieval timestamp and actual model. Estimates must include
a dated rate-card reference and cache/compaction treatment in their reference.
`fixture` means synthetic and must never be presented as a live bill. The ledger
records provenance but cannot audit a dishonest/incomplete adapter or reconcile an
external invoice automatically.

Phase is `planning`, `scouting`, `building`, `checking`, `reviewing`, or `integrating`.
Phases describe adapter-reported activity. They do not certify that a review or check
passed; only the independent verifier supplies the task's quality evidence.

## Stack-specific obligations

| Target     | Pin                                                                                                                                                               | Normalizer must capture                                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Piñata     | [2.0.1 source](https://github.com/funsaized/pinata/tree/9047a3d0f9d55e84a492e515fa01049ccf273dd4) plus the patched arena source digest                            | Parent Pi planning/verification/integration session and every child/repair/result-only attempt; evidence from checks, review and destination integration; all models. The parent owns the pipeline.    |
| OpenCode   | [2.2.5 source](https://github.com/anomalyco/opencode/tree/9bbb8ce18c80f099e0e448775f59d965ead40a21)                                                               | Parent and native subagent sessions, retry/compaction messages and actual model settings. Use a fresh outer container; shared-location subagents do not create isolation.                              |
| Pi example | [1.4.0 official extension](https://github.com/earendil-works/pi/tree/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/examples/extensions/subagent) | Install the extension and its agent definitions/prompts from the pinned source; record definitions/config digest, parent and all child models and receipts. This example is an extension, not core Pi. |

Do not relabel the older `test/quality/engine.ts` pipeline as this end-to-end study:
it uses a tiny parser and does not include the parent orchestrator. Before a real
study, pin prompts, tool permissions, models, provider settings, agent definitions,
CLI versions, image digests, prices and source revisions in the image/config; keep
those exact files as provenance. Confirm metering against provider receipts with a
small authorized calibration run. No built-in config claims that calibration.

## Configuring a real run

Generate a config from the image artifact; this writes a private, reviewable file
and does not start a model. Use a private task outside the contestant image.

```sh
node examples/arena/adapters/configure.mjs --image-file /tmp/arena-image.json \
  --out /private/arena.json --task /private/fresh-task \
  --base-url https://your-authorized-provider.example/v1 \
  --provider study --model exact-model-id --api-key-env STUDY_API_KEY
# Optional: --pricing /private/dated-rates.json --ca-file /path/public-ca.pem
# Inspect /private/arena.json and set provider account limits before running.
node examples/arena/cli.ts live --config /private/arena.json \
  --out /private/results-001 --allow-provider-spend
```

The named credential must already exist in the operator environment. Its value is
not copied into the run manifest. Never put credentials in URLs, config settings,
logs or shared artifacts. Public CA bundles are validated as certificates and mounted
read-only only in generation; the verifier receives neither CA nor credentials.
The immutable image must already exist locally; live execution never silently
installs a product or pulls an adapter image.

[live.example.json](live.example.json) also documents the generic protocol contract
for other products. Its image placeholders deliberately fail validation. `network:
"bridge"` permits provider access but does **not** restrict egress to that provider;
use an external egress policy and dedicated VM for hostile code. `network: "none"`
can serve offline protocol adapters but cannot reach host-local inference without
an explicitly implemented network design. Platform proxy/CA policy stays in effect.
The independent verifier always uses no network and receives no credentials.

No live provider run has been performed in this PR. An authorized small calibration
against real provider receipts remains necessary before a comparative paid study.
