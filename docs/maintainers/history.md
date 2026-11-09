# Historical evidence

The replacement preserves prior reports, corpus versions and result trees. The
earlier refactor's `PLAN.md`, readiness record, review reports and original
replacement plan describe the source they inspected. Their bytes remain unchanged.
Relative source links in those documents refer to the frozen revision
`c426753`, even where the replacement removed or moved that path.

Inspect the historical source with `git show c426753:PATH`, or check out that
revision separately. [The inventory](historical-source.json) records the full
revision, source paths/blob identities and SHA-256 hashes of the historical
documents. The documentation test verifies those hashes and resolves historical
links against that inventory. Current documentation must resolve against the
current checkout.

The [implementation record](rewrite-progress.md) identifies milestone source
archives, verification attempts and limits. Known-bad M0 characterizations and the
retired execution tests are archived at cutover rather than run against the new
engine. The frozen Git revision and archived source are rollback references, not
a second live runtime in the package.

Historical oracle results, failed attempts and usage claims are never rewritten
as current evidence. A new analysis has a separate path and identifies its source.

Final launcher inspection on November 9, 2026 identified the macOS Pi 1.5 path as
the installed Node CLI. Older macOS artifacts labeled `native` do not establish
compiled Bun execution; no per-run Node version is inferred when it was not
captured. The original records remain unchanged. See the corrected
[platform coverage](../how-to/platforms.md) and the local receipt
`bench/results/rewrite-2026-11-08/m8/final-validation/mac-pi-launcher-correction.json`.
