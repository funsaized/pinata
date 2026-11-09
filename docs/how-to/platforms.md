# Platform support

Pinata targets Linux, macOS and Windows with Node 22.19 or later. Direct development
dependencies are pinned and the lockfile is retained. Pi peer ranges remain broad,
while actual compatibility evidence is recorded for the tested versions.

Linux and macOS have actual scripted runs for journals, workspaces, application,
sessions, process cleanup, CLI/IPC and terminal navigation. The implementation
record names exact Node/Pi versions and retained failures. Node 22.19/24 cells are
part of release validation where those runtimes are available. Native Pi and Node
SDK observations are reported separately.

The current compiled Pi/Bun evidence is from Linux. macOS used the pinned SDK and
installed Pi 1.5 Node CLI; a compiled Pi executable was unavailable there. Older
macOS artifacts named `native` refer to that installed Node CLI.

Native Pi launches supervised workers and Herdr monitors through `node` on `PATH`;
make Node 22.19 or later available there. Trusted host integrations can select a
specific Node executable with `HostOptions.nodeCommand`. A Node-hosted Pi session
uses its current Node executable by default.

The owner deferred Windows runtime verification. Path/wire contracts and CI remain
portable, but the required Windows Job Object launcher helper has no verified
packaged binary. Supervised process cleanup and shell-dependent functionality on
Windows must report unavailable rather than claim success. File fsync is supported;
POSIX directory fsync has no demonstrated equivalent through Node on Windows.

Herdr requires its own available session and is conditionally exercised. Network
filesystems, power-loss durability and universal escaped-process containment are
outside the demonstrated results. See [implementation evidence](../maintainers/rewrite-progress.md)
for the current gate status; a declared support target is not a test pass.
