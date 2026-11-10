# Historical evidence

The completed plans, requirements, pre-rewrite reviews and readiness probes are
archived at Git revision
[`c426753291351c9b3b79a44c902cd5db17244c2a`](https://github.com/funsaized/pinata/tree/c426753291351c9b3b79a44c902cd5db17244c2a).
Read them there or use `git show c426753:PATH`. Their source links refer to that
revision. They describe the old implementation and are no longer shipped as
current guidance.

The archive includes `PLAN.md`, `HIGH_LEVEL_REQS.md` and these files under
`docs/maintainers/`:

- `refactor-validation.md` and `p0-p1-validation.md`
- `v3-review-handoff.md` and `v3-adversarial-review-prompt.md`
- `current-state-adversarial-review.md`
- `rewrite-plan.md` and `rewrite-readiness.md`

The [implementation record](rewrite-progress.md) identifies milestone source
archives, verification attempts and their limits. Raw arena and benchmark reports
remain at their recorded artifact paths, including failed and interrupted runs.
Historical oracle results and usage claims do not establish current behavior.

Final launcher inspection on November 9, 2026 identified the macOS Pi 1.5 path as
the installed Node CLI. Older macOS artifacts labeled `native` do not establish
compiled Bun execution; no per-run Node version is inferred when it was not
captured. See [platform coverage](../how-to/platforms.md) and the local receipt
`bench/results/rewrite-2026-11-08/m8/final-validation/mac-pi-launcher-correction.json`.
