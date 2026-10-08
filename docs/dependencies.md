# Give builders their dependencies

Builder worktrees start from your checkout as it was when the run began, but
only the files Git tracks or would track. Ignored directories such as
`node_modules` or `.venv` are missing, and so are ignored local files such as
`.env`. Before a builder starts, pinata runs one
setup command in its worktree. For most projects that command is detected for
you. Scout, research, planner, and reviewer tasks never run setup. Runs without
builders skip detection and report `source: "not-needed"`; leave setup alone and
continue the run. If you add a builder later, `add` resolves and reports its setup.
Use this guide to check builder setup, change it, or turn it off, and to give
every worker the local files it needs.

## Check what pinata detected

Ask Pi: “Show the builder setup command detected for this project before
starting the run.” It should explain the command and where it came from.

When using the helper directly, `init` resolves setup once per run and prints it:

```json
"setup": {
  "command": "npm ci --prefer-offline --no-audit --no-fund",
  "source": "detected",
  "lockfiles": ["package-lock.json"]
}
```

Read it before approving the run. `source` is one of:

| Source       | Meaning                                        |
| ------------ | ---------------------------------------------- |
| `detected`   | Chosen from lockfiles at the repository root   |
| `config`     | Your `config.setup` command                    |
| `none`       | Nothing will run; `reason` says why            |
| `disabled`   | You set `config.setup` to `false`              |
| `not-needed` | No builder tasks; setup is not detected or run |

Detection uses only root lockfiles and only commands that refuse to rewrite the
lockfile. See the [detection table](configuration.md#setup) for the exact
commands. A repository with both a JavaScript and a Python lockfile gets both
commands joined with `&&`.

## Set the command yourself

Set `setup` when detection reports `none`, picks the wrong command, or the
project needs more than an install. Put it in the project's `.pi/pinata.json` so
every run uses it:

```json
{
  "setup": "uv sync --frozen && make codegen"
}
```

A job's own `config.setup` overrides that file for one run.

The string runs with `sh -c` in the builder worktree. Common reasons to set it:

- **Conflicting lockfiles**, such as `package-lock.json` beside `yarn.lock`.
- **A missing package manager** on `PATH`. Install it, or name another command.
- **A monorepo** where one package is enough, as in
  [monorepo-setup-job.json](../examples/jobs/monorepo-setup-job.json).
- **Generated files** that tests need, like code generation after the install.

## Copy dependencies from your checkout instead

Setup receives `PINATA_ROOT`, the absolute path of your main checkout. When your
checkout already has current dependencies, copying them can be faster than
installing:

```json
"config": {
  "setup": "cp -a --reflink=auto \"$PINATA_ROOT/node_modules\" ."
}
```

On btrfs, XFS, and APFS (use `cp -c -R` on macOS) the copy shares disk blocks and
finishes almost instantly. Run directories live under `.git/pinata`, on the same
filesystem as the repository, so the clone works there. Check that your checkout's
dependencies match the lockfile first; a copy does not verify that.

## Copy local files with .worktreeinclude

Some checks need ignored files that an install does not create: a `.env` with
test settings, or a local config file. List them in `.worktreeinclude` at the
repository root, using `.gitignore` patterns:

```gitignore
.env
config/local.json
```

When pinata creates a worktree, it copies each ignored file that matches into
it. This applies to every role, not only builders. Claude Code uses the same file
for its worktrees, so one list can serve both.

A few rules keep the copies out of your results:

- Only files that are ignored in the worktree are copied. A file Git would track
  already reaches the worktree through the run's snapshot.
- Copies stay ignored, so they never appear in a builder's changes, a review
  diff, or an integration.
- Symbolic links, files over 16 MiB, and files that already exist in the
  worktree are skipped. More than 1000 matches fails the task; narrow the
  patterns.
- `status` lists what each task received as `included`.

Workers can read these files, and builders can run commands with them. List only
what the agents need.

## Turn setup off

```json
"config": { "setup": false }
```

Use this when builder checks do not need dependencies, or when you prefer to
fail fast and see which checks break.

## Fix a setup failure

A failed setup stops the attempt before Pi starts. The outcome has
`failureStage: "setup"` and the logs are `setup.stdout.log` and
`setup.stderr.log` in the attempt directory.

- **Transient failure** (registry timeout, offline cache miss): retry with
  `repair`. Setup retries have their own budget of two and do not consume the
  task's repair budget.

  Ask Pi to inspect the setup error and retry the affected builder. For direct
  commands, see [manual recovery](manual-recovery.md#fix-a-setup-failure).

- **"Setup changed project files"**: the command modified tracked or
  unignored files, for example an install that rewrote the lockfile, or a
  dependency directory that is not in `.gitignore`. That worktree can no longer
  be trusted as a clean starting point, so `repair` refuses. Fix the command or
  `.gitignore`, then start a new run.
- **Wrong command**: setup is fixed for the life of a run. Start a new run with
  a corrected `config.setup`.

## Prepared dependencies

With the default `workspaceReuse: true`, detected npm installs can reuse a
prepared `node_modules` from an earlier builder or run in the same repository.
The cache accepts registry-only lockfile v2/v3 installs without lifecycle hooks,
workspaces, or local links. It is populated only after successful supervisor
setup, before Pi starts. It never trusts an existing `node_modules` in your
checkout as a prepared environment.

The key includes package and lockfile contents, npm executable/version/settings,
Node version, OS/architecture, and relevant environment. Concurrent builders can
wait for the same preparation. Each receives a private copy, using native CoW
where available. Internal relative `.bin` links remain relative; external or
absolute symlinks prevent caching. A content digest verifies restored files.
A failed install never publishes an entry; damaged entries are bypassed.

Outcome `setup.cache` reports `hit` or `miss` when this path applies. A hit
skips `npm ci`, while retaining the same check that dependency preparation left
managed project files untouched. The per-worktree setup marker also supports
repairs without copying or installing again when its inputs are unchanged.

Custom setup, install hooks/native builds, pnpm/yarn/bun, Python environments,
and local/workspace packages retain their normal setup commands and package
manager caches. These can depend on absolute paths or arbitrary setup effects;
pinata does not relocate them automatically. `workspaceReuse: false` disables
prepared dependencies and inspection sharing for a job. The cache lives at
`<git-common-dir>/pinata/cache/dependencies/` and is retained across normal run
cleanup; it can be removed when no runs are using it.

This keeps the separate dependency environments described by
[Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) and
[Cursor worktrees](https://cursor.com/docs/configuration/worktrees). Cursor also
advises against symlinking mutable dependencies into the main checkout. See
[performance measurements](validation.md#workflow-and-reuse-validation) for the
measured cold/warm behavior and its limits.

## What setup does not do

- It runs only for builders. Scouts, planners, and researchers read files;
  reviewers use their target task's worktree. Eligible inspections of the same
  revision share a checkout; executable checks and builder ancestors require
  separate trees.
- It runs once per worktree. A repair attempt reuses the installed worktree and
  skips setup unless a dependency manifest or lockfile changed.
- Workers still cannot install packages. If a builder needs a new dependency,
  it reports a blocker. Add the dependency in your checkout and start a new run;
  the new lockfile reaches the worktree even before you commit it.
- It is not a sandbox. Setup runs with your user's permissions and network
  access, like any approved check.

Related: [setup reference](configuration.md#setup) ·
[why worktrees start clean](architecture.md#worktrees-and-ownership) ·
[Documentation index](README.md)
