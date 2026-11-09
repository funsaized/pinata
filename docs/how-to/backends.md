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

`attached` lifetime stops with its owning host. `surviving` is an explicit process
capability and requires a supported supervised backend. It preserves the original
attempt for reattachment; it does not mean a new owner may blindly repeat effects.
The worktree and durable store outlive idle session disposal.

Stop receipts distinguish stopped activity from unconfirmed ownership. Payload exit
alone is insufficient when descendants or output drains remain. A lost guardian,
ambiguous identity or unsupported helper cannot produce a confirmed-cleanup claim.
See [backend evidence](../maintainers/rewrite-backends.md), [recovery](recover.md)
and [platform support](platforms.md).
