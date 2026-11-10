# Herdr monitors

Select `backend: "herdr-pi"` only in an available Herdr session. Pinata owns the
monitor pane and validates its identity during attach/stop. Reused or missing panes
produce an explicit error. If Herdr is unavailable, the request fails without switching to the process backend.

The pane displays a supervised worker's observations; steering goes through the
same Runtime source as Pi/CLI. Do not send commands into a guessed pane or treat its
PID as independent cleanup authority. Use normal status, exact results, recovery
and cancellation. See [backend contracts](backends.md).
