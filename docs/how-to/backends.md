# Choose a backend

`in-process` creates Pi worker sessions inside the owning host. It has the lowest
process startup overhead and releases idle session resources after persistence.
`process` uses the same Pi session adapter in a supervised child with a durable
transport. `herdr-pi` adds an owned Herdr monitor to that process protocol. Choose
the backend in config or a worker override; unavailable capabilities fail before
launch instead of silently falling back.

Workspace mode is independent. Each backend can use the shared checkout or an
explicit worktree where supported. Tools, selected skills, filtered context,
memory and ordinary continuation follow the same frozen worker contract.

`attached` lifetime stops when its owning host disconnects. `surviving` requires a
supported supervised backend and preserves the original attempt for reattachment
after the host is lost. Explicit host shutdown stops both lifetimes. A new owner
must inspect the retained attempt before deciding how to continue.
The worktree and durable store outlive idle session disposal.

A stop receipt confirms cleanup only when ownership and termination are known.
The payload exiting is insufficient if descendants are still running or output
is still draining. Cleanup remains unconfirmed if the guardian is lost, identity
is ambiguous or the required helper is unsupported.
See [backend evidence](../maintainers/rewrite-backends.md), [recovery](recover.md)
and [platform support](platforms.md).
