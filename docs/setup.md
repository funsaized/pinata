# Set up pinata

Install pinata, open Pi in your project, and ask it to delegate.

## 1. Check prerequisites

You need Pi 1.0.2 or newer, Herdr 0.9.1 or newer with a running compatible server,
Node 22.19.0 or newer, Git, and an authenticated model supported by Pi. Linux has
been validated; macOS has not. See [validation](validation.md) for tested versions.

Run Pi inside a Herdr pane in a Git repository with an existing commit. Workers
start from your checkout as it is, uncommitted changes included. If you run
outside Herdr, configure an existing named session as described below.
Reviewing GitHub pull requests also needs the GitHub CLI (`gh`), signed in.

## 2. Install and reload

```sh
pi install npm:pi-pinata
```

Restart Pi or run `/reload`. For a local checkout, install with
`pi install /absolute/path/to/pinata` instead.

## 3. Ask Pi to check setup and delegate

For native completion, enable Herdr's Pi integration with
`herdr integration install pi`, then reload Pi. This lets Pinata identify the
parent session, end its turn after launch, and resume it when workers finish.
Without a matching session, Pinata reports a legacy completion route and keeps
the parent turn active. See [completion and yield](commands.md#typed-pi-tools).

```text
Check that pinata is ready in this project. If it is, use a scout subagent to
identify the main entry points and existing tests. Report findings with file
references. Do not change project files or install anything.
```

Pi can check installed resources, prerequisites, and model readiness before
launching. Missing tools or an unavailable Herdr server need to be resolved first;
pinata does not install them or start the server. Workers use your current Pi
model by default, so no model configuration is required.

Next: [Run your first scout](tutorials/first-scout.md) or
[Build and review a change](tutorials/build-and-review.md).

The remaining sections cover optional configuration and troubleshooting.

## Choose models (optional)

pinata needs no configuration: without any, every worker uses the model your
Pi session has selected. To pick models per role, create
`~/.pi/agent/pinata.json`. Ask Pi to check available models and authentication,
or check them directly without printing credentials:

```sh
pi --list-models
pi auth check --provider YOUR_PROVIDER --model YOUR_MODEL --json --no-refresh
```

Then write the file, replacing the placeholders:

```json
{
  "models": {
    "default": { "provider": "YOUR_PROVIDER", "id": "YOUR_MODEL", "thinking": "medium" },
    "reviewer": { "provider": "YOUR_PROVIDER", "id": "ANOTHER_MODEL", "thinking": "high" }
  }
}
```

Choose a thinking level that Pi actually applies to the model; pinata rejects a
selection Pi changes. [examples/configs](../examples/configs/) has ready-made
files: one model for everything ([luna.json](../examples/configs/luna.json)), a
model per role with a builder fallback
([per-role.json](../examples/configs/per-role.json)), research
([research.json](../examples/configs/research.json)), and codemode turned off
([no-codemode.json](../examples/configs/no-codemode.json)). If you keep dotfiles
in a repository, symlink the file from there.

A project can override any of it in its own `.pi/pinata.json`, for example a
different reviewer or a `setup` command. See [config files](configuration.md#config-files).

Run Pi inside a Herdr pane, or add `"session": "YOUR_EXISTING_HERDR_SESSION"` to
the file to target a named Herdr session.

Two other defaults need no configuration. Workers get Pi's codemode tool
([how to change that](codemode.md)), and builder worktrees get their
dependencies from a setup command detected from your lockfiles
([how to check it](dependencies.md)).

## Enable research

Skip this section if you only need local code tasks. Without pi-web-access,
everything else works; only jobs containing research tasks are refused at `init`.

1. Install and configure [pi-web-access](https://github.com/nicobailon/pi-web-access)
   separately, with permission to change your Pi configuration.
2. Ask Pi to check research readiness. pinata detects pi-web-access among your
   installed Pi packages. Set `config.webExtension` only to use a different copy.
3. Confirm the approved search provider and its authentication. If credentials
   come from environment variables, add only their names to `config.passEnv`.
   Never put credential values in job JSON.
4. The diagnostic checks the extension entry file; a live research task still
   needs to reach and authenticate with the provider.

[web-search.json](../examples/web-search.json) is a restrictive policy example
for pi-web-access 0.35.0: Tavily search, direct HTTP fetch, no hosted/cookie
fallback, and no summary workflow. Merge only approved settings; do not overwrite
your existing policy.

Research reports should cite fetched sources and identify evidence gaps. Missing
authentication or unavailable tools must be resolved before research can finish.

## Manual diagnostics

To inspect helper output yourself, use `pi list` to locate the installed
package, then set a shell variable to its helper:

```sh
PINATA=/absolute/installed/package/lib/pinata.mjs
node "$PINATA" resources /absolute/path/to/a/project
```

The output should have `ok: true` and resolve two skills and six prompts to the
installed package. If a personal resource uses the same name, resolve the
collision in Pi configuration. Do not overwrite existing skills or prompts.
The probe ignores untrusted project resources, so also check the active
session's diagnostics for trusted project resources that shadow a global name.

```sh
node "$PINATA" doctor
```

Run `doctor` from a project to see the effective configuration: `configFiles`
lists the files it read and `configOrigins` says which file set each value.
Proceed only if preflight succeeds. Fix a missing executable, incompatible
server, or invalid file before creating a run. The helper checks authentication
and exact model selection before worker launch, not during `doctor`.

## Remove the package

First [cancel or reconcile active runs and preview cleanup](recovery.md#cancel-and-clean-up).
Do not remove helper files while workers still use them.

```sh
pi remove npm:pi-pinata
# For a local checkout, use the exact source you registered:
pi remove /absolute/path/to/pinata
```

Removal unregisters resources. It does not delete run evidence or dirty worker
worktrees.

Next: [Run your first scout](tutorials/first-scout.md) · [Documentation index](README.md)
