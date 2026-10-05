# Give builders their dependencies

Builder worktrees start from committed `HEAD`, so ignored directories such as
`node_modules` or `.venv` are missing. Before a builder starts, pinata runs one
setup command in its worktree. For most projects that command is detected for
you. Scout, research, planner, and reviewer tasks never run setup. Runs without
builders skip detection and report `source: "not-needed"`; leave setup alone and
continue the run. If you add a builder later, `add` resolves and reports its setup.
Use this guide to check builder setup, change it, or turn it off.

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

| Source       | Meaning                                                |
| ------------ | ------------------------------------------------------ |
| `detected`   | Chosen from lockfiles committed at the repository root |
| `config`     | Your `config.setup` command                            |
| `none`       | Nothing will run; `reason` says why                    |
| `disabled`   | You set `config.setup` to `false`                      |
| `not-needed` | No builder tasks; setup is not detected or run         |

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
dependencies match the committed lockfile first; a copy does not verify that.

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

## What setup does not do

- It runs only for builders. Scouts, planners, and researchers read files;
  reviewers share their target builder's worktree.
- It runs once per worktree. A repair attempt reuses the installed worktree and
  skips setup unless a lockfile changed.
- Workers still cannot install packages. If a builder needs a new dependency,
  it reports a blocker. Add the dependency in your checkout, commit it, and start
  a new run.
- It is not a sandbox. Setup runs with your user's permissions and network
  access, like any approved check.

Related: [setup reference](configuration.md#setup) ·
[why worktrees start clean](architecture.md#worktrees-and-ownership) ·
[Documentation index](README.md)
