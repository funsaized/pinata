# Give builders their dependencies

Builder worktrees start from your checkout as it was when the run began, but
only the files Git tracks or would track. Ignored directories such as
`node_modules` or `.venv` are missing, and so are ignored local files such as
`.env`. Before a builder starts, pinata runs one
setup command in its worktree. For most projects that command is detected for
you. Scout, research, planner, and reviewer tasks read your live checkout and never run setup.
Use this guide to check builder setup, change it, or turn it off, and to give builders the
local files they need.

## Check what pinata detected

Ask Pi: “Show the builder setup command detected for this project before
starting the run.” It should explain the command and where it came from.

pinata resolves setup once per run, when the run starts, and records it with each
builder's result:

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
lockfile. See the [detection table](../reference/config.md#setup) for the exact
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

The string runs with `sh -c` in the builder worktree (`cmd.exe /d /s /c` on Windows). Common reasons to set it:

- **Conflicting lockfiles**, such as `package-lock.json` beside `yarn.lock`.
- **A missing package manager** on `PATH`. Install it, or name another command.
- **A monorepo** where one package is enough, as in
  [monorepo-setup-job.json](../../examples/jobs/monorepo-setup-job.json).
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

On filesystems that support reflinks, this can share data blocks while keeping
each copy independently writable. On macOS, use `cp -c -R` where supported.
Copy performance depends on the filesystem and dependency tree. Check that your
checkout's dependencies match the lockfile first; this custom command does not
verify that.

## Copy local files with .worktreeinclude

Some checks need ignored files that an install does not create: a `.env` with
test settings, or a local config file. List them in `.worktreeinclude` at the
repository root, using `.gitignore` patterns:

```gitignore
.env
config/local.json
```

When pinata creates a builder's worktree, it copies each ignored file that matches into
it. (Other roles read your live checkout, where the files already are.) Claude Code uses the same file
for its worktrees, so one list can serve both.

A few rules keep the copies out of your results:

- Only files that are ignored in the worktree are copied. A file Git would track
  already reaches the worktree through the run's snapshot.
- Copies stay ignored, so they never appear in a builder's changes, a review
  diff, or an integration.
- Symbolic links, files over 16 MiB, and files that already exist in the
  worktree are skipped. More than 1000 matches fails the task; narrow the
  patterns.

Builders can read these files, and builders can run commands with them. List only
what the agents need.

## Turn setup off

```json
"config": { "setup": false }
```

Use this when builder checks do not need dependencies, or when you prefer to
fail fast and see which checks break.

## Fix a setup failure

A failed setup fails the builder before its agent starts. Its reason starts with
`Setup failed`, and names the log file, kept under `<run>/setup/<task>/`.

- **Transient failure** (registry timeout, offline cache miss): ask Pi to repair the
  builder; `pinata_repair` prepares the worktree again and reruns setup.
- **"Setup changed project files"**: the command modified tracked or unignored files, for
  example an install that rewrote the lockfile, or a dependency directory missing from
  `.gitignore`. Fix the command or `.gitignore`, then start a new run.
- **Wrong command**: setup is fixed for the life of a run. Start a new run with a
  corrected `config.setup`.

## Reuse prepared dependencies

Detected npm installs reuse prepared dependencies automatically when the project has a
registry-only lockfile v2/v3 and no install hooks: each builder gets its own writable copy
of a content-checked tree under `<git common dir>/pinata/cache/dependencies/`, and the
builder's result records `setup.cache` as `hit` or `miss`. Custom commands and other
package managers run normally. Changes to the lockfile, Node version or npm configuration
make a new entry; a damaged entry falls back to a normal install. To reclaim the space,
remove that directory while no run is going.

## What setup does not do

- It runs only for builders.
- It runs once per worktree and lockfile state; a repair skips it unless a lockfile
  changed.
- Agents still cannot install packages. If a builder needs a new dependency, it reports a
  blocker. Add the dependency in your checkout and start a new run; the new lockfile
  reaches the worktree even before you commit it.
- It is not a sandbox. Setup runs with your permissions and network access, like any
  approved check.

Related: [setup reference](../reference/config.md#setup) ·
[trust and safety](../explanation/trust.md)
