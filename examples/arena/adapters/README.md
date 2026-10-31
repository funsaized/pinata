# Container adapter contract, v1

The runner executes a pinned local container image and an argument array. It never
runs a contestant command on the host. `live` requires `--allow-provider-spend` even
when the adapter claims its provider is free. This flag is operator consent, not a
hard spending guarantee. No provider calls are part of the repository's tests.

**Bundled status:** Piñata 2.0.1, OpenCode 2.2.5 native subagents, and Pi 1.4.0's
official subagent example are named, source-pinned integration targets, not verified
live adapters. The executable generic protocol path is tested with an offline
container fixture. Install/configure each real stack in an image, implement its
normalizer, audit its telemetry, and pin that image before using it for a study.
The demo's three labels all use the same Piñata FakeBackend script.

Commands on this page are _manual_ and require a configured, authorized live adapter.

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

Copy [live.example.json](live.example.json), replace image placeholders with local
immutable image digests, point commands at your audited normalizers, set a private
task package, and configure only the credentials needed for the selected provider.
Use `network: "none"` for local inference or `"bridge"` for an explicitly authorized
provider run. Docker's inherited proxy configuration remains in effect; the harness
does not install an unrestricted egress proxy. Restrict egress externally for live
work. The verifier always uses `network: "none"` and gets no provider credentials.

```sh
node examples/arena/cli.ts live --config /private/arena.json \
  --out /private/results-001 --allow-provider-spend
```

The example deliberately fails validation until all immutable images are supplied.
The command never silently installs a product or pulls a live adapter image.
