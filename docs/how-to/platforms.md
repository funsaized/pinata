# Platform support

Pinata targets Linux, macOS and Windows with Node 22.19 or later. Direct development
dependencies are pinned and the lockfile is retained. Pi peer ranges remain broad,
while actual compatibility evidence is recorded for the tested versions.

Linux and macOS have actual scripted runs for journals, workspaces, application,
sessions, process cleanup, CLI/IPC and terminal navigation. The implementation
record names exact Node/Pi versions and retained failures. Node 22.19/24 cells are
part of release validation where those runtimes are available. Native Pi and Node
SDK observations are reported separately.

The retained cutover measurements used compiled Pi/Bun on Linux and the Pi 1.5
Node CLI on macOS. Older macOS artifacts named `native` refer to that Node CLI.
Current CI exercises native Pi binaries separately and records the host and worker
runtimes; the cutover reports are not relabeled as results of those newer runs.

Native Pi launches supervised workers and Herdr monitors through `node` on `PATH`;
make Node 22.19 or later available there. Trusted host integrations can select a
specific Node executable with `HostOptions.nodeCommand`. A Node-hosted Pi session
uses its current Node executable by default.

Windows requires the .NET Framework 4 C# compiler. Pinata compiles its packaged
launcher source on first use and caches the executable under
`%LOCALAPPDATA%\\Pinata\\job-launcher`, keyed by source, compiler and architecture.
No helper binary or runtime is downloaded. A build receipt checks the cached
executable before use; a missing compiler or changed cache fails the launch.

The Windows CI matrix runs Node 22.19 and 24 on x64 and ARM64. It exercises real
Job Objects, descendants, cancellation, reconnect, host loss, creation failures,
argument/environment handling, Pi process sessions, the installed package and
native Pi's default Node workers. It also retains the portable contract/storage
suite. This is targeted runtime coverage; the full workspace/application fault
matrices and terminal-navigation suite run on Linux/macOS.

Executable arguments are passed as data through `CreateProcessW`. Explicit
`.cmd`/`.bat` invocations support ordinary quoted arguments and reject shell
expansion characters; invoke an executable directly for arbitrary argument data.
Job membership is established at creation, and cleanup requires zero active job
processes plus closure of its last owned handle. A lost launcher acknowledgment
retains an unconfirmed receipt. See the [launcher contract](../../engine/backends/supervision/windows-selection.md).
Windows file fsync is supported; POSIX directory fsync has no demonstrated
equivalent through Node on Windows.

Herdr requires its own available session and is conditionally exercised. Network
filesystems, power-loss durability and universal escaped-process containment are
outside the demonstrated results. See [implementation evidence](https://github.com/funsaized/pinata/blob/9a6d9de/docs/maintainers/rewrite-progress.md)
for the current gate status; a declared support target is not a test pass.
