# Set up on Windows and macOS

Pinata supports Linux, macOS, and Windows. CI tests all three.

## Windows

Install [Git for Windows](https://git-scm.com/download/win), Node 22.19+, and Pi 1.1.0+.

- Builder `setup` commands run with `cmd.exe /d /s /c`. Use cmd syntax or call a
  script. For example, `"setup": "npm ci"` works on all three platforms.
- `checks` run as argument arrays without a shell. For `.cmd` launchers such as
  `npm`, Pinata uses `cmd.exe` and quotes each argument.
- Pinata stops agents in separate processes with `taskkill /T /F`.
- Pinata uses PowerShell's `Get-Process` to identify processes. The first process
  check after Pi starts takes a moment; Pinata measures that delay once.

## macOS

Install Git through the Xcode command line tools, Node 22.19+, and Pi 1.1.0+.

Temporary paths resolve through `/private`. Pinata compares the real paths of
builder write roots, so no extra setup is needed.

## Linux

Make sure `git` and `pi` are on `PATH`. No extra setup is needed.
