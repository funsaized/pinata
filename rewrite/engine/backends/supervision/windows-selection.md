# Windows supervisor selection

The selected implementation target is a project-owned, source-packaged C#
`PinataJobLauncher` using explicit Win32 interop. The portable supervisor contract
already distinguishes a Windows Job Object from a POSIX process group. Windows
launch and cleanup currently report **unavailable / unverified**. There is no
`taskkill`, POSIX emulation, or process-backend fallback presented as confirmed
cleanup. The owner deferred Windows runtime verification; this record does not
claim that an executable helper has been built or tested.

## Packaging and maintenance comparison

| Candidate                            | Packaging and maintenance cost                                                                                                                                                    | Decision                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Native Node addon                    | Per-architecture native artifacts, Node/Bun ABI compatibility or an N-API dependency, compiler support and ongoing upstream ownership                                             | Not selected; supervision should survive independently of either model host runtime.                                  |
| Prebuilt Rust/C++ launcher           | Small native process with direct Windows APIs, but requires a new compiler toolchain, x64/arm64 release artifacts and a verified artifact supply path                             | Feasible alternative if the selected source route proves too costly; no unchecked download at runtime.                |
| Project-owned C# launcher            | Reviewable source in the package, built with the Windows .NET toolchain; no Node ABI dependency; can initially use Windows PowerShell `Add-Type` for explicit, cached compilation | Selected implementation target. Compilation/build provenance and cold-start cost must be measured before enabling it. |
| PID-tree enumeration plus `taskkill` | No controlled enrollment and cannot prove cleanup when the leader has already disappeared or identifiers were reused                                                              | Rejected as a cleanup authority.                                                                                      |

PowerShell documents compilation of source and calls to unmanaged functions through
P/Invoke; this supports the packaging option, not its runtime correctness.
[Microsoft Add-Type documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type).

## Required native protocol

Create a Job Object and set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before creating
the payload. Pass its handle through `PROC_THREAD_ATTRIBUTE_JOB_LIST` in
`STARTUPINFOEX` to `CreateProcessW`, so membership is established during creation.
This attribute is supported on Windows 10 / Windows Server 2016 and later.
[Microsoft process attribute documentation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

Creating a suspended child and then calling `AssignProcessToJobObject` is not the
selected enrollment algorithm: launcher death between those calls can leave an
unowned suspended process. The job-list attribute removes that user-space gap.
The guardian must retain the job handle, disable breakaway, bind control to its
live nonce and launcher identity, and confirm zero active job processes before
returning `stopped`. Closing the final job handle is a cleanup mechanism, while a
lost launcher receipt still requires explicit uncertainty and retained exclusion.
Job membership, descendant inheritance and job termination are documented by
[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

The launcher must handle executable argument quoting separately from explicit
`.cmd`/`.bat` invocation. It must pass an explicit Unicode environment block,
restrict inherited handles to the intended pipes, and preserve output plus launch
and cleanup evidence. The host acknowledges durable enrollment before writable
execution is exposed. Attached host loss closes owned activity; surviving lifetime
keeps the independent guardian and authenticated reconnect channel.

The contract suite must exercise creation failures at every handle/setup boundary,
launcher death before and after child creation, descendants, nested job restrictions,
quoting, paths with spaces, cancellation, reconnect and x64/arm64 packaging. No
Windows capability becomes `confirmed` from typechecking this port or from POSIX
results. Actual Windows verification remains deferred and is a release limitation.
