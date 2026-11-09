# Measure runtime performance

The benchmark uses scripted or HTTP loopback providers. It measures runtime
coordination, storage, sessions and cleanup; it does not measure model coding
quality or time saved on a project.

```sh
PINATA_PI=/absolute/path/to/pi node scripts/bench-ci.mjs engine --expose-gc bench/run.ts --ci --host pi
npm run bench:process -- --repeat 5 --scenario fanout-1 --scenario fanout-8
PINATA_PI=/absolute/path/to/pi npm run bench -- --host tui --scenario ux-8
node --expose-gc bench/viewer.ts --repeat 3
```

The [measurement protocol](rewrite-benchmarks.md) defines each timing, memory and
coverage field. The in-process budgets in `bench/budgets.json` retain their 2× CI tolerance.
The owner accepted revised 50/40/60 ms latency limits on November 8, 2026; the
[measurement protocol](rewrite-benchmarks.md) records the original failed attempts
and exact scope of that acceptance. A complete over-budget attempt may retry twice; every
attempt remains in the report. Missing measurements, incomplete usage, failed
execution or unconfirmed cleanup fail immediately. Process and Herdr timing is
advisory until matching platform baselines exist. Unavailable backends are recorded
as unavailable, not silently replaced.

The CI wrapper measures in `os.tmpdir()` unless `PINATA_BENCH_ROOT` explicitly
selects another root. The runtime workflow selects `/dev/shm` on Linux to match
the accepted tmpfs baseline, and the runner's temporary directory on macOS for
the APFS profile. Benchmarks use native Pi 1.5.0, matching the retained Linux
baseline; native Pi 1.1.0 remains a separate compatibility smoke. A missing
measurement root or benchmark executable fails the run. The wrapper copies
the entire successful or failed batch back to
`bench/results/`, with original-path mapping, and retains the source files. This
keeps report retention independent of measurement storage without a filesystem
fallback. Direct `bench/run.ts` invocation measures beside its `--out` path;
`--ci` does not change that medium. Reports record actual filesystem type, block
size, device and canonical cell directory. Baseline comparison rejects missing or
different storage provenance.
Shared GitHub runners gate execution, accounting and cleanup; their performance
measurements use the advisory profile. The accepted Linux latency baseline used
Node 22.19.0 on a Ryzen 5900XT. Both Node 22 and 24 exceeded its limits on shared
runners, and Mac dependency dispatch varied between passing and failing
runs. Those failed batches remain failed. Run the explicit `--ci` command above
on controlled hardware to enforce the unchanged performance limits.
Darwin CI selects the approved APFS profile only after observing the filesystem
name and checking its device identity against the actual allocation. Missing or
mismatched proof retains the default limits. Reports record the profile, exact
limits and 2× factor; comparisons require matching named profiles.
The wrapper forwards SIGINT/SIGTERM, waits for the runner and retains its files
before preserving the interrupt exit status. SIGKILL cannot run that final copy;
the synced command status identifies the original measurement directory.

The accepted local latency limits were measured on Linux tmpfs. The retained
btrfs repository-disk cohort failed startup/setup limits and remains failed.
The Linux tmpfs cohorts passed all eight gates on the frozen v7 source and again
after adding named profiles, with exact unchanged `default-v1` limits.
The valid macOS APFS cohort passed execution, accounting, cleanup, memory and UI
checks but exceeded four startup/setup latency limits. Its report remains failed.
The owner accepted separate 150/450/350/450 ms Mac/APFS limits and required a fresh
passing run. The fresh run passed all eight scenarios on their first attempts
with verified `darwin-apfs-v1` selection. Linux and all other gates remain unchanged.
The [measurement record](rewrite-benchmarks.md) contains the exact scope and
retained evidence. The two hosts differ in storage
and Pi launcher, so these are not matched platform comparisons.

## Workloads and comparisons

Default workloads exercise fan-out at 1/8/32/64 workers, dependencies, independent
and dependent work, and streaming. Additional scale and retained-history probes:

```sh
npm run bench -- --scenario scale-queue-1000 --scenario scale-fanin-256 --scenario scale-batches-8
npm run bench -- --sweep --workers 1,8,32,64 --histories 1,128,1024
```

Use `--mode lean|observe`, `--viewer attached|detached`,
`--workspace shared|worktree`, `--backend in-process|process|herdr-pi` and
`--lifetime attached|surviving` to select independent axes. Keep scripts, tool
access, runtime, hardware and configuration matched. Source changes during a
cohort make its comparison unstable. Native Pi/Bun and the Node SDK host require
separate provenance. Run timing comparisons on a quiet host.

Reports use unique JSON and Markdown paths under `bench/results/`; `--out` refuses
to overwrite either file. Each cell is durably allocated before launch and retains
its specification, status, raw measurements and supervisor evidence in the
adjacent `.cells` directory. Keep incomplete and failed cells. A killed harness
does not prove nested workers stopped: reconcile their exact supervisor identities
and retain that evidence before claiming cleanup.

Startup includes the committed preparing boundary through the first ordinary
workload provider request. Compaction requests retain separate identities without
inferring the current assignment from historical conversation text, so this is
not first-all-provider latency when compaction precedes workload generation. Full
elapsed time, CPU and runtime usage still include compaction. The local HTTP
fixture observes closure of its own idle connections before post-workload resource
sampling; the exact resource-plateau and usage-completeness gates remain unchanged.
Backend setup, acceptance, dependency dispatch and command-to-request measure
different intervals. RSS samples are lower bounds, with host and child coverage
reported separately. Retained heap follows collection; it can grow with durable
history. Native hosts that lack a working resource inventory use explicitly
labeled descriptor counts, which do not prove timer coverage.

## Interpreting evidence

The UI target is p95 event/key-to-render-request at most 100 ms with eight scripted
workers. Actual terminal capture is separate. Repeated navigation and follow-up
cycles must release owned resources. Component profiles identify reducer, queue,
outbox, consumption, restore, skill-loading, fingerprint and durable-IO costs.

Investigate any regression beyond the preserved gates. Keep the original
measurements when fixing a hot path. Do not change the timing boundary or exclude
failed retries to make a result pass. A durability cost can be accepted explicitly
with evidence; it must not be described as a free improvement.

Before claiming a runtime optimization remedies arena performance, matched
profiles must show that runtime overhead accounts for at least 10% of the affected
end-to-end path. Smaller improvements remain useful local improvements. Only
separately authorized [coding evaluations](coding-arena.md) can support claims
about coding completion, speed or quality.
