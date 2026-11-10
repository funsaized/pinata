# Write and check repository prose

Use direct sentences, name the actor when it matters, and explain the behavior a
reader can observe. Preserve technical qualifications, code examples and evidence
limits. Review claims against the implementation before polishing the wording.

## Setup and commands

Run these commands from the repository with Node 22.19 or later and Git available:

```sh
npm run docs:setup
npm run docs:lint
npm run docs:lint:changed
npm run docs:lint:agents
```

Setup downloads Vale 3.26.0, verifies its release checksum and fetches Google 0.7.1
and the ai-tells package by `tbhb` 1.37.0 from pinned release URLs. It supports Linux, macOS and
Windows on x64 and ARM64. Extraction uses `tar`; Windows uses the system `tar.exe`.
The binary and downloaded styles stay in ignored `.vale/` directories. Run setup
again after changing a version pin. Ordinary scans need no network or model calls.

`docs:lint` checks maintained reader documentation. `docs:lint:changed` checks
staged, unstaged and untracked prose against HEAD. To include branch commits,
compare against the merge base with an existing local or remote reference:

```sh
npm run docs:lint:changed -- --base origin/master
npm run docs:lint:agents -- --changed
node scripts/vale.mjs --json
```

The agent command selects repository instructions, agent definitions, prompts and
skills. It applies spelling, repetition and Pinata terminology checks without the
reader profile's editorial rules. Code blocks and inline code remain outside prose
checks. Unknown options and unavailable comparison references fail explicitly.

All v1 findings are advisory, including spelling and terminology. Commands return
success after reporting findings, but fail for missing tools, invalid configuration
or execution errors. CI runs both profiles in one documentation job and retains
JSON reports. This job is separate from `npm run check`. Oxfmt still owns formatting.

## Scope

The reader scan includes the root README, maintained Markdown under `docs/`,
`arena/README.md` and example explanations. It excludes generated reference output,
`docs/maintainers/history.md`, `docs/maintainers/rewrite-*.md`, benchmark records,
arena fixtures/results, Relay starter fixtures and the expected-report oracle.
Those files preserve generated content or historical evidence. Update a generator
or an example contract deliberately rather than rewriting its output for style.
The selectors in `scripts/vale.mjs` define both profiles for local runs and CI.

## Rules and vocabulary

`.vale.ini` explicitly enables a subset of Google: headings, heading punctuation,
word choices, first-person language, gender bias, Latin phrases and spacing.
It enables five ai-tells rules: adjective/noun pairs, stock compound phrases,
sycophancy, closing pleasantries and self-references. These are suggestions to
inspect in context, never evidence of authorship. Adding an upstream rule requires
an explicit configuration change.

Vale supplies spelling and repetition checks. The local `Pinata` rules correct
specific product-name variants and the terms subagent and worktree. Accepted
spellings live in `.vale/styles/config/vocabularies/Pinata/accept.txt`; substitutions
live in `.vale/styles/Pinata/`. Add vocabulary only after checking the term. Keep
identifiers and commands in inline code rather than adding them all to the dictionary.

The initial scan reported 54 findings in reader prose and 16 in operational
instructions. Most came from technical vocabulary, CLI terminology and product
names in headings. The Google excessive-claims rule also flagged qualified
statements about guarantees and best-effort control, so it is not enabled.
Calibration included the README, first-run tutorial, API reference and trust guide.
The selected AI-prose rules found no matches in that baseline.

## Editing workflow

Read the whole passage before changing a flagged phrase. Use a humanizer pass to
remove filler, repetitive openings and awkward phrasing while keeping every claim.
Keep reference prose neutral. Do not invent a first-person anecdote or remove a
useful limitation to make prose sound more casual.

Run the relevant changed-file scan, inspect findings and format edited files.
A suggestion may be inappropriate for a technical term or deliberate example;
retain the meaning and explain a rule exception when needed. Review the final diff
for changed commands, links, permissions and recovery instructions. Vale does not
verify factual claims, working examples or agreement with the implementation.

The rule sources are [Google](https://github.com/vale-cli/Google) and
[ai-tells](https://github.com/tbhb/vale-ai-tells). See
[Vale](https://github.com/vale-cli/vale) for the engine and supported integrations.
