# Set up on Windows and macOS

pinata runs the same on Linux, macOS and Windows; CI tests all three.

## Windows

- Install [Git for Windows](https://git-scm.com/download/win) and Node 22.19+, and Pi 1.1.0+.
- Builder `setup` strings run with `cmd.exe /d /s /c`. Write them for cmd, or call a
  script: `"setup": "npm ci"` works everywhere.
- `checks` are argv arrays run without a shell. `.cmd` launchers such as `npm` work:
  pinata runs them through `cmd.exe` with each argument quoted.
- Agents in their own processes are stopped with `taskkill /T /F`.
- Process identity uses PowerShell's `Get-Process`, so the first ownership check after Pi
  starts takes a moment; pinata measures it once.
- Not measured on Windows: the interactive UX benchmark and the viewer runtime benchmark
  (no pseudo-terminal there). Herdr is not verified on Windows yet.

## macOS

- Install Git (Xcode command line tools), Node 22.19+ and Pi 1.1.0+.
- Temporary paths resolve through `/private`; pinata compares a builder's write root by
  real path, so this needs nothing from you.
- Change capture is slower on some macOS machines (up to about 130 ms on CI runners for a
  2,000-file repository); it happens once per builder.

## Linux

Nothing special. `git` and `pi` on `PATH`.
