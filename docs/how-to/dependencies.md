# Give builders their dependencies

Builder worktrees start with your checkout's tracked and untracked files when the
run begins. Ignored files are left out, including `node_modules`, `.venv`, and
`.env`. Pinata prepares dependencies before the builder starts, using a setup
command it can usually detect for you.

Each worktree has its own dependencies and lives outside your checkout and `.git`,
under [`worktreeRoot`](../reference/config.md#worktree-location). Run metadata and
setup logs live under `<git common dir>/pinata/`.

## Check the setup command

Ask Pi to show the detected setup command and explain where it came from before
starting the run.

Pinata chooses the command once, at the start of the run, and records it in each
builder's result:

```json
"setup": {
  "command": "npm ci --prefer-offline --no-audit --no-fund",
  "source": "detected",
  "lockfiles": ["package-lock.json"]
}
```

The `source` field tells you how Pinata chose it:

| Source       | Meaning                                        |
| ------------ | ---------------------------------------------- |
| `detected`   | Chosen from lockfiles at the repository root   |
| `config`     | Your `config.setup` command                    |
| `none`       | Nothing will run; `reason` says why            |
| `disabled`   | You set `config.setup` to `false`              |
| `not-needed` | No builder tasks; setup is not detected or run |

Pinata checks lockfiles at the repository root and chooses commands that leave
them unchanged. If it finds both JavaScript and Python lockfiles, it joins their
install commands with `&&`. See the [detection table](../reference/config.md#setup)
for the commands.

## Set the command yourself

If detection finds no command, chooses the wrong one, or your project needs extra
steps, ask Pi to set `setup`. Save it in the project's `.pi/pinata.json` to use it
for every run:

```json
{
  "setup": "uv sync --frozen && make codegen"
}
```

A run's `config.setup` overrides this default.

The command runs in the builder's worktree with `sh -c`, or `cmd.exe /d /s /c`
on Windows. You may need your own command when:

- Lockfiles conflict, such as `package-lock.json` alongside `yarn.lock`.
- The package manager is missing from `PATH`. Install it or choose another command.
- A monorepo only needs dependencies for one package, as in
  [monorepo-setup-job.json](../../examples/jobs/monorepo-setup-job.json).
- Tests need generated files, so you must run code generation after installing.

## Copy dependencies from your checkout instead

If your checkout already has the right dependencies, copying them may be faster
than installing. Setup receives `PINATA_ROOT`, the absolute path of your main
checkout:

```json
"config": {
  "setup": "cp -a --reflink=auto \"$PINATA_ROOT/node_modules\" ."
}
```

Check that those dependencies match the lockfile before copying them. On filesystems that support reflinks, copies can share data blocks while
remaining independently writable. On macOS, use `cp -c -R` where supported. Speed
depends on the filesystem and the dependencies being copied.

## Copy local files with .worktreeinclude

For ignored files that setup does not create, such as a `.env` with test settings,
add a `.worktreeinclude` file at the repository root. It uses `.gitignore` patterns:

```gitignore
.env
config/local.json
```

Pinata copies matching ignored files when it creates the builder's worktree.
Claude Code uses the same file for its worktrees, so you can share the list.

The copy rules are:

- Files must be ignored in the worktree. Tracked and unignored files already come
  from the run's snapshot.
- Copies stay ignored and are excluded from builder changes, review diffs, and integration.
- Pinata skips symbolic links, files over 16 MiB, and files already in the worktree.
  More than 1000 matches fails the task; use narrower patterns.

Builders can read these files and use them in commands. Include only what they need.

## Turn setup off

Ask Pi to disable setup for the run, or set:

```json
"config": { "setup": false }
```

Use this when checks need no dependencies, or to see which checks fail without them.

## Fix a setup failure

If setup fails, the builder's agent does not start. A command failure reports
`Setup failed` and names the log file under `<run>/setup/<task>/`.

- For a registry timeout or offline cache miss, ask Pi to repair the builder.
  `pinata_repair` prepares the worktree again and retries setup.
- `Setup changed project files` means the command changed tracked or unignored
  files. An install may have rewritten the lockfile, or a dependency directory may
  be missing from `.gitignore`. Fix the command or `.gitignore` and start a new run.
- If the command is wrong, start a new run with a corrected `config.setup`.
  The setup command stays fixed throughout a run.

## Reuse prepared dependencies

Pinata can automatically reuse dependencies for detected npm installs with a version
2 or 3 lockfile, registry packages only, and no install hooks. It checks the cached
contents and gives each builder its own writable copy. The cache lives under
`<git common dir>/pinata/cache/dependencies/`; results show `setup.cache` as `hit`
or `miss`. Custom commands and other package managers run normally.

A changed lockfile, Node version, or npm configuration creates a new cache entry.
If an entry is damaged, Pinata runs a normal install. To free the space, remove the
cache directory while no runs are active.

## Setup limits

- Setup runs only for `worktree` agents, including `builder`. It never runs for
  `live-readonly` or `review-target` agents.
- After setup succeeds, repairs reuse it unless a lockfile or package manifest
  (such as `package.json`) changes in the worktree.
- Agents cannot install packages themselves. If a builder needs a new dependency,
  it reports a blocker. Add it in your checkout and start a new run. The worktree
  receives the updated lockfile even if you have not committed it.
- Setup runs with your permissions and network access, like an approved check.

Related: [setup reference](../reference/config.md#setup) ·
[trust and safety](../explanation/trust.md)

## Dependencies of checks

A configured check runs in the same isolated workspace as its builder: the run's
base plus declared predecessor changes. Declare check dependencies in `after`,
just like implementation dependencies. Pinata does not infer imports from commands.

For an isolated storage unit check, construct a canonical state fixture instead of
importing `emptyState` from an independent store builder. Put a compatibility check
after both store and storage so both implementations are available.

Check failures retain the command/ID, workspace, declared predecessors, failure
stage and stdout/stderr paths. Read the logs before diagnosing a missing dependency.
A failed command still fails the task. Setup and checks share the run's saved
deadline; retrying setup or repairing a builder does not start a fresh job budget.
