# Windows Job Object launcher

Pinata ships `PinataJobLauncher.cs` and builds it with the system .NET Framework
C# compiler. The executable has no Node/Bun ABI dependency and needs no downloaded
runtime. The source, compiler and architecture select its cache directory under
`%LOCALAPPDATA%\\Pinata\\job-launcher`. A build receipt records the executable's
SHA-256; a changed cache fails verification rather than running unchecked bytes.
CI logs cold build time and tests x64 and ARM64 with Node 22.19 and 24.

## Enrollment and lifetime

The shared Node guardian owns the authenticated control channel, durable output
and recovery evidence. Its C# sidecar creates a named Job Object, enables
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and retains the only job handle. Neither
breakaway flag is enabled. The guardian publishes its identity and waits for the
host's durable enrollment acknowledgment before authorizing a payload.

The sidecar passes the job handle in `PROC_THREAD_ATTRIBUTE_JOB_LIST` to
`CreateProcessW`. Membership is established during creation, with no separate
suspend-and-assign gap. `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` restricts inherited
handles to the three payload pipes; the job handle is not inherited. See
[Microsoft's process attribute contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

An explicit Unicode environment block and CRT argument quoting preserve executable
argument data. `.cmd` and `.bat` use a separate `cmd.exe` path with delayed
expansion disabled; shell metacharacters in those arguments are rejected. Direct
executable invocation supports arbitrary ordinary argument data, including quotes,
Unicode, spaces and empty strings.

Attached host loss requests cleanup. A surviving guardian remains reconnectable
after its original host exits. If the guardian dies, the sidecar sees pipe EOF and
terminates the job; if the sidecar dies, Windows closes its job handle and kills
the associated processes. These mechanisms cover ordinary job-inheriting process
creation, not a permission sandbox or every possible external process service.

## Cleanup evidence

Stop requests use the live authenticated guardian. The sidecar terminates its job,
queries the native active-process count until zero, drains the pipes, closes the
job handle and exits. The guardian then retains an armed stop record binding the
job name and launcher UUID to that empty-and-closed proof. The host also confirms
the original guardian has ended before issuing a stopped receipt.

A missing acknowledgment, failed observation or lost launcher produces
`unconfirmed`, even when kill-on-close has stopped the payload. Reconciliation
requires the matching immutable stop evidence and current guardian absence. It
never uses a saved PID, job name or `taskkill` command as termination authority.
The kernel's job membership and termination behavior are documented in
[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

The shared tests exercise input/output, cancellation, descendants after root exit,
authentication, reconnect and host loss. Windows-specific tests cover native
creation-boundary crashes, Unicode/environment/argument handling, inherited pipes,+nested jobs, explicit command-script invocation and lost-launcher uncertainty.
CI also exercises real Pi process sessions, the installed package and native Pi's
default Node worker. Native-worker reports and run files are retained as artifacts.
