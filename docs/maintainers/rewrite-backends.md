# Replacement backend transport and supervision

The production adapters under `engine/backends/` use the common runtime and
supervision contracts. They do not import the archived backend implementation.
Pi sessions use the installed public `ModelRuntime.create` and
`createAgentSession` APIs. Scripted provider bootstrap modules are explicit trusted
host configuration; a model cannot select a module or grant itself capabilities.

## Process workers

A process worker publishes immutable artifacts and its own transport streams. It
never writes the run lifecycle journal. The owning Runtime commits observations
using the original backend source identity and ordinal; replay does not launch a
second process or resend an uncertain input. The worker's command, response and
observation files use checksummed frames, exclusive publication and file/directory synchronization.
An input receipt records transport handling separately from the Pi checkpoint that
proves consumption. Input retries retain the same logical message identity.

Each process observation, including a text delta, is synchronized separately; the
final outcome waits for that stream to drain. Large answers emitted in thousands
of tiny chunks can therefore delay completion after generation ends. The final
macOS paging-fixture diagnostics reproduced this cost. Those fixtures now use
larger deterministic chunks while retaining the same complete answers, paging
assertions and deadlines. This test adjustment does not improve production
streaming throughput or change transport durability.

The launch manifest retains the exact assignment, attempt and original owner epoch.
Reattachment validates that manifest, saved guardian enrollment and a live
nonce-bound guardian channel. `Runtime.recover` supplies authority from the current
run claim; a new epoch string alone does not authorize an external caller. An
explicit handoff records the next runtime epoch in a durable command/acknowledgment
before detaching the old handle. The original attempt epoch remains on cleanup
receipts. Surviving workers retain their conversation, assignment outcome, usage,
observations and raw process output for later attachment.

If cleanup finished before the Runtime recorded settlement, explicit recovery can
restore the terminal outcome from its durable worker stop response and matching
outcome. It independently reconciles the original guardian's stopped evidence and
replays the existing observation identities. It launches no process and sends no
input. Missing or conflicting stop evidence remains unconfirmed.

Attached lifetime stops with its host. Surviving lifetime requires explicit backend
support and keeps its guardian available after host loss. Foreground waiting and
worker lifetime are separate choices. Process and Herdr handles can detach; the
neutral Runtime owns admission, recovery and shutdown behavior.

## Cleanup and output

A payload exit is not proof that its descendants stopped or that its output pipes
finished. The resident POSIX guardian retains the group while payload leaders exit,
and only the live guardian signals that owned group. Cleanup reports `stopped` or
`unconfirmed` with evidence. Missing guardian identity, escaped activity or an
unconfirmed nested shell cleanup retains the writer gate.

`SupervisedProcess.outputDrained` resolves only after both stream readers finish and
the output files are synchronized. Its byte counts describe complete retained
output. It rejects if the guardian channel closes first. Descendants can keep pipes
open after payload exit, so callers needing complete output await this separate
receipt. Forced cleanup can retain partial bytes without claiming complete output.

`reconcileSupervisor(identity, { reason })` is an explicit offline inspection. It
requires matching local enrollment, immutable armed-stop evidence and current
absence of enrolled, escaped and group activity. It sends no signals, refuses
conflicting or missing evidence, and retains its reason and observations. Ordinary
`stopSupervisor` does not infer a successful stop merely from a missing PID.

Windows uses the source-packaged C# Job Object launcher, built with the system
.NET Framework compiler. Payloads enter the job during process creation. Cleanup
requires a matching native empty-and-closed job receipt; losing the launcher
retains uncertainty. There is no `taskkill` or alternative-backend fallback. See
[`windows-selection.md`](../../engine/backends/supervision/windows-selection.md).

## Herdr monitor panes

The optional `herdr-pi` adapter runs the same supervised Pi worker and opens an owned
Herdr **monitor pane**. It does not claim to be an interactive Pi TUI. Input and
steering pass through the Runtime. The monitor reads the durable worker stream and
strips terminal control sequences from model activity.

The adapter retains the workspace, pane and terminal identities before launching
the monitor. It checks those identities before control and cleanup. Cleanup closes
only the original pane, preserving other panes a user may have added to the same
workspace. A changed terminal identity is never closed and produces unconfirmed
cleanup. An unacknowledged creation retains its unique creation intent for explicit
reconciliation. Herdr CLI helper processes use the same guardian cleanup protocol.

Without a configured or inherited Herdr session the adapter reports unavailable.
The tests include fake pane reuse and setup failures, plus an installed-Herdr smoke
when a local session is available. The local smoke uses a new unfocused test pane,
reads its rendered worker output, reattaches the same saved pane and closes only
that pane. Windows Job Object tests run separately; paid model evaluations require
their own authorization.
