# pinata

Pi subagents through skills, bash, and [Herdr](https://herdr.dev/). Distributed as
**`pi-pinata`**; unrelated to the Pinata storage SDK.

- Exactly two skills: discoverable `subagents` and explicit-only `engmgmt`.
- Five global prompt templates: `/scout`, `/research`, `/planner`, `/builder`,
  `/reviewer`.
- Three workers per run by default, isolated writer worktrees, dependency barriers,
  independent adversarial review, bounded repairs, and verified integration.
- No bundled Pi extension, MCP server, daemon, database, runtime npm dependencies,
  or terminal-specific pane API.

## Install

Requires **Pi ≥1.0.2**, **Herdr ≥0.9.1** with a running compatible server,
**Node ≥22.19.0**, and Git. Model access is external configuration. Research also
requires an already-installed [pi-web-access](https://github.com/nicobailon/pi-web-access).
The helper detects prerequisites; it does not install or upgrade them.

Install from npm:

```sh
pi install npm:pi-pinata
```

Or clone this repository and register its absolute path:

```sh
pi install /absolute/path/to/pinata
```

These commands change your personal Pi configuration; use them only when you
intend to install. Do not copy files over existing skills/prompts. Restart Pi or
use `/reload`. A personal installation works in unrelated projects and worktrees.
Use `pi list` to locate the installed package and verify its exact resources:

```sh
node /absolute/installed/package/lib/pinata.mjs resources /an/unrelated/project
```

A missing or shadowed resource is a blocker, not a reason to overwrite yours.
Resolve name collisions explicitly in Pi configuration. This probe intentionally
ignores untrusted project resources; a project's trusted prompts/extensions can
still shadow global commands. Check the active session's diagnostics too.

## Use

For engineering coordination, invoke the skill explicitly:

```text
/skill:engmgmt Fix the approved issue through tests, adversarial review, and local integration.
Do not commit, push, publish, or deploy.
```

Or ask Pi to delegate a bounded assignment:

```text
Use a scout subagent to trace the request-validation path and identify the narrowest regression check.
```

The coordinator reads `subagents`, records scope and acceptance criteria, selects
configured models, creates a private run, collects every required result, and
integrates only reviewed changes. `engmgmt` explicitly loads `subagents`; Pi has
no implicit skill inheritance.

Invoking `/scout` or another persona directly changes the **current conversation's
prompt**. It does not launch a child. The skills and helper do the delegation.

An idle pane, a settled agent, or exit zero alone is **not success**. Pi can emit
an assistant error and still exit zero. pinata requires correlated terminal
results, actual file/check evidence, and applicable review gates.

## Configuration and operation

See [configuration](docs/configuration.md) for JSON contracts and commands,
[architecture](docs/architecture.md) for lifecycle diagrams and trust boundaries,
and [examples](examples/) for editable configurations.

Jobs operate from a Git root with an existing commit. Builders start at that
commit, not a copy of arbitrary dirty user work. State is private under
`<git-common-dir>/pinata/<run-id>/`, outside checked-out/package content.
Keep the returned run path for `status`, `resume`, `cancel`, and cleanup.

Read-only personas do not get bash/edit/write tools. Builders are not sandboxed:
Pi runs with your OS permissions. Review tasks/check commands before approving
them. Workers must not delegate, install, stage, commit, publish, or deploy.
The coordinator owns separately authorized release actions.

## Development and validation

From a repository checkout (tests and lockfiles are not shipped in the tarball):

```sh
npm ci --ignore-scripts
npm test
npm run test:pi
npm run lint
npm run format:check
```

`test:pi` packs and installs locally in a scratch npm prefix, registers resources
in an isolated Pi configuration, and uses a localhost provider fixture. It does
not use live model credentials or change personal Pi configuration.

`npm run test:herdr` requires an explicit opt-in and creates/closes owned Herdr
panes with mock Pi workers. `npm run test:live` requires separate live-spending
authorization and configuration. See [validation and limitations](docs/validation.md)
for exact coverage and the deferred macOS checklist.

Linux is the current validation target. **macOS: designed for compatibility; not
yet validated.** No native macOS, Mac Ghostty, Tailscale, or Dotbento setup is
included. Headless Herdr checks are not outer-terminal UI validation.

## Remove and publish

```sh
pi remove npm:pi-pinata
# For a locally registered checkout, use the exact source you installed:
pi remove /absolute/path/to/pinata
```

Removal unregisters package resources; it does not delete your run artifacts or
dirty worker worktrees. Cancel/reconcile runs first and preview cleanup.

[Publication instructions](docs/publication.md) target npm account
[`funsaized`](https://www.npmjs.com/~funsaized). Nothing here publishes, pushes,
commits, or reserves a package name automatically.

MIT licensed.
