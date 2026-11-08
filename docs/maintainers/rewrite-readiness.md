# v3.0.0 rewrite readiness record

The bounded M0 pass is complete. The [replacement plan](rewrite-plan.md) now targets
new implementations of the core, stores, backends, workspace/application, UI and
harness, with one final package cutover. The owner selected v3.0.0, authorized these
scripted probes and macOS access through Tailscale, and deferred Windows verification
while retaining Windows in the design. No paid provider or model-backed arena was run.
No production engine or existing harness behavior was changed by M0.

The next implementation is M1: new canonical contracts, a durable command ledger,
atomic ownership and atomic acceptance. The probes establish counterexamples and
bounded feasibility; they are not completed production fixes. In particular, tests
named `baseline F*` intentionally pass when the frozen defects are reproduced.

## Baseline and evidence

The selected branch state was committed as
`d1c386f642415ab999ba1c3a8ef4c8f3b00b2689` on `efficiency`, with parent
`34fc66e9d163e15aca49796414daed8dd368757e`. It includes the formerly dirty/untracked
implementation, tests, requirements and review/planning inputs. `PLAN.md` still
records the previous refactor and was not overwritten.

Local, ignored evidence lives under `bench/results/readiness-2026-11-08/`:

| Artifact                                  | Contents                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `baseline/source.tar.gz`                  | All 410 tracked files at the frozen commit; SHA-256 `08c3f328a4fb29b83066af6f47c02201aa5e1c948eb3258a6cb137a58c923224`. |
| `baseline/branch.bundle`                  | Git history/ref capture; SHA-256 `564086827985bf2f4a61f1ebfa36791fd3efce8b22120dcb1b01d405c3a35876`.                    |
| `baseline/manifest.json`                  | Source hashes, nonsecret runtime versions and in-place hashes for 4,690 retained historical evidence files.             |
| `baseline/check.log`, `baseline/test.log` | Actual baseline validation output, including individual tests.                                                          |
| Root `*-attempt-*.log`, `profile-*.json`  | Linux probes and all attempts, including failures.                                                                      |
| `macos/`                                  | Explicitly copied macOS logs/profiles and UI terminal/event artifacts.                                                  |
| `ui-*/events.jsonl`, `ui-*/terminal.bin`  | Offline UI navigation/draft/disposal observations and actual PTY output.                                                |
| `final/`                                  | Final check/test logs, source archive, Git bundle, hash inventory and source/evidence preservation result.              |

The captured source and dependency lockfile are sufficient to reconstruct the probe
inputs; installed dependencies, credentials and unrelated user configuration are not
archived. macOS used an isolated temporary checkout and agent directories; existing
projects and global configuration were not modified. Only enumerated result files
were copied back. Historical result files are hashed in place, never rewritten.
Raw evidence is local and ignored, not silently included in the npm package.

## Actual environments and checks

| Environment | Recorded runtime / storage                                                                                                                             | Work performed                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux x64   | Linux 7.2.15, Node 26.12.0, npm 12.2.1; SDK Pi 1.1.0; native Pi 1.5.0; repository on btrfs, disposable test fixtures on tmpfs                          | Baseline/full local suite, all readiness probes, SDK/native UI and scripted profiles. Existing Herdr conformance ran with loopback responses in the available local Herdr session. |
| macOS arm64 | macOS 27.0.1 / Darwin 27; login shell Node 22.23.1 / npm 10.9.8, direct SSH Node 26.9.0 / npm 11.19.1; Git 2.54.0; SDK Pi 1.1.0; native Pi 1.5.0; APFS | 52 focused application/path/store/backend tests, all readiness probes, SDK/native UI and scripted profiles through Tailscale SSH. No macOS Herdr claim.                            |
| Windows     | Not exercised                                                                                                                                          | Owner-deferred verification; launcher, process ownership, paths and native Job Object support remain in the implementation plan.                                                   |

Baseline `npm run check` passed. Baseline `npm test` passed 397 engine tests with
2 Windows-specific skips, then 3 scheduler tests and 6 release tests: **406 passed,
2 skipped**. The macOS focused suite passed **52/52**. The readiness suite passed
**24/24 on both hosts**. These are individual tests, not file-level runner summaries.
Final `check` and `npm test` also passed with the same counts; Linux logs are under
`final/`. Final macOS readiness passes are retained separately for Node 22 and 26
under `macos/`. All 263 compared runtime/probe/package source files match the local
checkout. All 4,690 historical evidence hashes and both baseline archive hashes
still match, as recorded in `final/preservation.json`.

Node's isolated test runner in the restricted local environment can report file
passes without usable child-test output. `test:readiness` explicitly disables test
isolation, selecting `--test-isolation=none` on Node 26 or
`--experimental-test-isolation=none` on Node 22. Tests needing local sockets/process
supervision ran with the required execution access. This does not change production
behavior or weaken assertions.

Maintained entry points:

```sh
npm ci
npm run check
npm run test:readiness
npm test
```

Focused macOS baseline command (no paid calls):

```sh
node --test --experimental-test-isolation=none \
  test/engine/integrate.test.ts test/engine/paths.test.ts \
  test/engine/store.test.ts test/engine/backends.test.ts
```

Run each profile with a new output path on the filesystem being measured:

```sh
node test/readiness/profile.ts bench/results/readiness-profile-unique.json
```

The POSIX UI driver requires Python 3 and a new output directory. It uses an empty
agent directory, offline mode, no ambient extensions/skills/context, and a provider
request guard. Example using the installed SDK CLI:

```sh
python3 test/readiness/ui-pty.py --root "$PWD" \
  --out bench/results/readiness-ui-unique \
  --pi node "$PWD/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
```

Use an absolute native Pi path with `--pi` for the native run. No model request is
needed. Assertions cover modifier-arrow dispatch, three screen visits, streaming
renders, conversation navigation, three disposals and the restored emoji/CJK draft.
The driver exits through Pi's ordinary interrupt-key path after observing completion.

## Results and architectural decisions

| Investigation                         | Observed result                                                                                                                                                                                                                                                                                                                                                       | Decision / limit                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1: rollback/cursor authority**     | Real `atomicJson` boundaries were instrumented with a test-only loader. Kill and injected IO error after terminal-journal rename/directory sync reproduce false reapplication; earlier temporary-file boundaries recover. Four application-cursor kill boundaries recover the intended bytes. HEAD/index/unrelated-file assertions passed.                            | Make phase and cursor map one authoritative application record; rebuild cursor projections. M3 needs every destination-write boundary and conflict/recovery matrix, beyond this bounded probe.                                              |
| **F2: descendant cleanup**            | On both hosts, the baseline stop methods return while an owned, non-detached, TERM-resistant leaf survives its leader. A resident guardian retains the group identity; wrong nonce is refused, and the correct stop removes guardian/leaf after payload exit. Forged generation and unrelated-host identities are refused.                                            | Select a live guardian/control binding for POSIX. Actual PID reuse was not induced. Guardian death, escaped processes, complete enrollment, detached handoff and Windows remain production gates; uncertainty must retain writer exclusion. |
| **F3/F4: acceptance and wait**        | An invalid `base/999` addition persists `audit` and blocks its corrected retry. `next:true` ignores active assignment 1 when assignment 2 is queued.                                                                                                                                                                                                                  | M1 commits validation/acceptance/inbox/receipt atomically; M2 waits snapshot all currently pending exact targets and subscribe without a gap.                                                                                               |
| **F5: usage coverage**                | Mixed logs report 20 input tokens and $0.40 while the fixture's complete observations total 1,020 and $10.40. The independent prototype reconciles per-attempt records, deduplicates identical observations and leaves missing, malformed, conflicting or interrupted coverage unknown.                                                                               | Preserve explicit expected coverage, cached input semantics and provenance. This prototype does not repair the analyzer or attest external child execution.                                                                                 |
| **F6/F7: freshness**                  | A warm empty context cache misses new AGENTS.md; a cold lookup finds it. Dirty `first` → dirty `second` yields the same baseline status fingerprint.                                                                                                                                                                                                                  | Rediscover candidate instruction paths and use scoped content observations. Test concurrency and measure cost before adding caches; never equate freshness with authorship.                                                                 |
| **F8: false review claim**            | An isolated completed fixture with no review evidence renders “reviews complete.”                                                                                                                                                                                                                                                                                     | New shared projections/renderers separate execution, reported assessment, acceptance, delivery and correctness. No engine review gate is added.                                                                                             |
| **A1: dependency result identity**    | Both `base/1` and `base/2` edges remain, but the actual downstream result map contains only assignment 2. The saved assignment-1 result still exists.                                                                                                                                                                                                                 | Full assignment references must key both graphs and payloads; test two actual downstream summaries, not just edges.                                                                                                                         |
| **A2: competing run claims**          | Two independently constructed hosts pause after reading one unowned settled record, then both return handles for the same run. The final file records only one PID. Duplicate model execution was not exercised.                                                                                                                                                      | Atomic cross-process run claim is necessary. The exclusive-create prototype admits one contender and refuses even a dead owner's claim until explicit reconciliation.                                                                       |
| **A3: interrupted batch publication** | A test-only replacement for the external runner allocates a fixture batch and is killed. The real matrix retains `running` with `batch:null` despite the created directory. No adapter/model is executed.                                                                                                                                                             | Allocate and publish stable batch/cell identities before launch in the new harness; preserve interrupted uncertainty and pending cells.                                                                                                     |
| **Ledger feasibility**                | Synced framed/hash-chained assignment+inbox records replay after process death and lost receipts without duplicates. Same-ID/different-payload retries fail; concurrent duplicate requests serialize; a torn tail is retained and blocks further writes.                                                                                                              | Select a new fsynced Node journal. Test-only offline removal of the reaped fixture owner's record is not a recovery algorithm. Claim fencing, artifacts, all IO failures, committed corruption and power-loss assumptions remain M1 work.   |
| **Schema bridge**                     | Zod 4.6.7 exports nested/discriminated/optional strict input shapes accepted by Pi 1.1.0's actual TypeBox validator. Invalid extra keys fail. Pi can coerce a number string and remove a simple optional null before canonical validation; raw Zod rejects those inputs. Domain refinements still require canonical validation; transforms reject JSON-schema export. | One canonical schema plus a tested bridge; document transport normalization. No unsupported claim that arbitrary raw invalid payloads behave identically across Pi/CLI. The complete output/schema registry is M1 work.                     |
| **Context/skills APIs**               | Public branch/fork APIs select an immutable parent branch but also copy custom host entries. The public loader selects the explicit skill with ambient skills disabled and grants no tools. Compacted session usage returns null tokens/percent, not zero.                                                                                                            | Import a filtered capability-neutral context projection, not a raw file fork. Use supported loader options and display unknown context usage honestly. Full tool-pair/compaction/backend import parity remains M2/M5.                       |
| **UI APIs**                           | SDK and native Pi pass the offline non-overlay screen/draft/stream/disposal probe on Linux and macOS. Actual PTY bytes are retained.                                                                                                                                                                                                                                  | Use the public non-overlay custom screen plus main widget. This is API feasibility, not a full fleet UI, 100-cycle leak test, eight-worker latency result or subjective usability approval.                                                 |

The F labels refer to the independent review; A1 was found during initial planning,
and A2/A3 during readiness. None is presented as an explanation for the historical
`unknown dependency prices` incident. That incident remains unexplained.

The relevant SDK behavior was checked against installed declarations and executable
probes. The owner-linked [OpenAI agent guide](https://developers.openai.com/api/docs/guides/agents/define-agents)
describes SDK configuration rather than a Codex Markdown file grammar; the plan
maps those concepts into required Markdown/frontmatter and namespaced Pinata options.
[Zod's schema documentation](https://zod.dev/json-schema) supports the bridge boundary.
[Node process-group behavior](https://nodejs.org/api/child_process.html#optionsdetached)
and [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
inform the separate supervision ports; they do not substitute for platform tests.

## Scripted measurements

Profiles use the real baseline reducer, atomic writer, completion delivery scan and
session-consumption reader; the new ledger is the test-only candidate. Measurements
are milliseconds, with raw samples retained. The table uses the later samples taken
after the other test jobs finished: `profile-linux-quiet-1.json` and
`macos/profile-macos-quiet-1.json`. These used Node 26.12.0 and 26.9.0 respectively;
the earlier macOS profile used Node 22.23.1.

| Operation                                              | Samples | Linux median / sample p95 | macOS median / sample p95 |
| ------------------------------------------------------ | ------- | ------------------------- | ------------------------- |
| Atomic JSON, 4 KiB payload, sync/rename                | 50      | 1.365 / 1.623             | 9.981 / 10.156            |
| Prototype follow-up acknowledgment, full replay + sync | 200     | 1.215 / 1.588             | 6.815 / 8.843             |
| Reducer, 5,000 deltas, 1 worker / 1 assignment         | 4       | 10.516 / 13.075           | 14.769 / 29.990           |
| Reducer, 5,000 deltas, 64 workers / 1 assignment       | 4       | 25.662 / 27.433           | 22.704 / 28.439           |
| Reducer, 5,000 deltas, 1 worker / 128 assignments      | 4       | 36.119 / 36.619           | 33.641 / 33.679           |
| Reducer, 5,000 deltas, 1 worker / 1,024 assignments    | 4       | 244.258 / 248.438         | 284.166 / 287.037         |
| Already-delivered outbox rescan, 10,001 events         | 5       | 12.845 / 15.757           | 9.180 / 11.150            |
| Consumed-input scan, 10,000 session entries            | 5       | 9.516 / 10.530            | 7.287 / 12.050            |

The first reducer sample includes warm-up; four samples do not establish a stable
latency tail. Earlier profiles are retained and show run-to-run variation. These
hosts differ in CPU, Node version, filesystem and load, so the columns are observations,
not an OS ranking or a matched before/after comparison. The two write rows perform
different work and cannot establish that the prototype is faster or equally durable.

The useful design conclusion is narrow: keep historical totals off per-delta paths,
index completion/consumption lookup, and budget for durable IO. These costs do not
explain minute-scale four-worker arena timelines or establish coding-performance gains.
The historical matrix still has 10/10 scored oracle passes and 0/4 Pinata completions;
no fresh live evidence changes that denominator.

## Retained failures and scope limits

- `ownership-attempt-1.log`: three checks passed; the torn-tail check's cleanup
  failed because its temporary directory was removed before closing the owner.
  The fixture now closes explicitly in `finally`; full later passes retain the same
  torn-tail assertions. This was test cleanup, not a successful store repair.
- `ui-sdk-attempt-1.log`: the screens/draft sequence completed, but requesting
  shutdown inside the active async shortcut did not exit within 25 seconds. The
  driver now exits through ordinary Ctrl+C keys after observing completion. The
  original terminal/events are retained; no SDK shutdown fix is claimed.
- `macos/baseline-macos.log`: Node 22 rejected Node 26's stable isolation option
  before tests ran. The recorded second attempt uses the supported experimental
  spelling and ran 52 individual tests. The readiness runner chooses explicitly.
- All initial focused passes, complete readiness passes, both initial profiles and
  later quiet profiles remain. Failed attempts are not replaced by passing logs.

M0 does not prove power-loss durability, real PID reuse, hostile/escaped-process
containment, Windows runtime behavior, new Herdr-supervisor integration, complete
backend context parity, the final UI's responsiveness, earliest correctness, complete
live cost or coding superiority. Those are bounded implementation or later evaluation
gates in the plan. No unresolved owner choice blocks M1, and no absence of live-spend
authorization blocks a truthful functional implementation.
