# Run your first scout

Ask Pi to delegate a small code question, then read the scout's findings.
Complete [setup](../setup.md) first and open Pi in a Herdr pane in your project.
Choose a Git repository with at least one commit.
This makes model calls using your current Pi model unless you configured overrides.

## 1. Ask Pi to delegate

Choose a function or behavior in your project and replace the example below:

```text
Use a scout subagent to trace the request-validation path in this repository.
Return the entry points, relevant callers, and existing tests with file and
line references. Identify a missing test if you find one. Do not change files
or run commands in the scout.
```

Ask for a **scout subagent** explicitly. Typing `/scout` alone applies a persona
to your current conversation; it does not launch a child agent.

## 2. Let Pi collect the result

Pi checks prerequisites, prepares the task, and launches the scout in a separate
Herdr workspace. When the scout finishes, Pi receives completion and collects
its report. You do not need to create job JSON or poll helper commands.

The scout can read and search files, but cannot edit, run tests, or browse the web.
It sees your files as they were when you asked, including uncommitted edits and
new files, but not ignored files such as `node_modules`. If the run is blocked,
ask Pi to explain the blocker; see [recovery](../recovery.md).

While it runs, Pi shows the scout's state, time, and cost above the editor. Type
`/pinata` at any point for the same view without asking the model.

## 3. Read the findings

Look for:

- Specific files and lines that explain the behavior.
- Existing tests and any gaps in coverage.
- A clear distinction between observed code and proposed changes.

A scout may suggest a test, but cannot claim to have run it. Ask Pi a follow-up
if the report is too vague, for example: “Which caller passes this value, and
what test covers it?”

Your project files should remain unchanged. Finished panes and unchanged scout
worktrees are removed automatically; saved results remain available.

Next: [Build and review a change](build-and-review.md) · [More prompts](../../examples/README.md)

For a reproducible greeting fixture and manual commands, use the optional
[Node helper tutorial](helper-first-scout.md).
