# Piñata Strategy

## Vision
<!-- vision: author-approved 2026-11-26 -->

Piñata exists to make orchestrating subagents and workflows in Pi a pleasant developer experience.
A developer can see what is waiting, step into the conversation that needs attention and return to the original assignment without losing their place.
The coordinator is the main thread where the developer directs the task.
Piñata owns fleet orchestration.
Its API translates the coordinator’s requests into assignments and manages them through execution and recovery.

### The coordinator chooses the workflow

The coordinator divides the work, interprets reports and decides what runs next, which checks matter and when to accept the result.
The engine dispatches assignments from their declared dependencies and available capacity.
A parent waiting on its children still occupies its slot.
Finished work is available to the coordinator even when checks fail or an assignment ends partway through.

Teams express their conventions in agent definitions and prompts.
Shipped specialists follow the same launch rules as a project’s own agents.
A worker’s report is input to the coordinator’s decision about which branch to take.
Giving a named worker one opportunity to wake the main thread for a decision fits this model when the coordinator extends the invitation.

### Developers can reach the work directly

From the fleet, a developer can see who delegated an assignment, trace its dependencies and open its conversation.
Steering or stopping a worker from the owning session takes no coordinator model turn.
The performance that matters here is the delay developers encounter when dispatching work or navigating a busy fleet.
Scripted benchmarks measure the overhead Piñata adds to those operations.

A follow-up keeps the conversation and workspace and gives the new assignment its own result.
A change that lets the coordinator revise a specialist between assignments fits when the host checks the new grants and each assignment records the definition it ran with.

### Hosts share an engine and set the grants

The Pi extension, embedded hosts and saved-run viewers read one event model.
The core rules for accepting work and tracking its state run independently of Pi.
A saved-run viewer reads the recorded run and leaves commands, including stop requests, to the owning session or host.

The `in-process` backend runs a worker inside the host, `process` runs it under a supervisor, and `herdr-pi` adds a Herdr terminal pane for observing the supervised worker.
Each backend honors the same launch contract and rejects work that requires a capability it lacks.
The host grants tools, workspace access and permission to delegate.
A child stays within its parent’s grants, and messages carry the sender’s identity.
Model output can inform a decision only within the authority the host has already granted.

### Work starts in the developer’s checkout

The shared checkout is the default, including when the developer has uncommitted edits.
The coordinator arranges overlapping work and can choose separate Git worktrees when parallel changes need isolation.
A worktree isolates a patch for integration and inherits the operating-system access of the account running the worker.

A preview shows the files at the time of inspection.
An explicit apply request selects the worktree’s current changes, checks the destination for conflicts and records the operation in a journal.
Piñata serializes application and rollback while leaving the checkout open to ordinary editors and workers.
If a later edit conflicts with rollback, Piñata preserves it for the coordinator to resolve.

### Recovery follows the original attempt

After a lost reply, the coordinator can look up the original request before repeating work.
If a supervisor disappears, recovery seeks the original attempt and reports what it can establish.
Starting a replacement is a separate coordinator decision once the uncertainty is visible.
Cancellation preserves partial work and records process cleanup separately from the worker’s reported outcome.

### Scope

External integrations own calendar schedules and the preparation of redacted run exports for sharing.
The workflow chooses file ownership assignments, required reviews and production spending limits.
The execution environment supplies operating-system containment.

A change aligns when it makes a fleet easier or faster to direct through the shared engine and leaves workflow decisions with the main thread.
A change should be resisted when it lets report content dispatch work, withholds a result pending approval, or overwrites a developer’s edits to complete a handoff.
