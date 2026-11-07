# Code Style

Optimize for correctness, readability, maintainability, and obviousness. A reader
should understand a function from top to bottom without mentally executing it or
jumping through several abstractions. Oxfmt controls formatting; Oxlint handles
mechanical linting.

## Variables and names

Use `const` by default, `let` for reassignment, and never `var`. Name values for
what they represent: `pendingTasks`, `reviewFingerprint`, or `destinationTree`
rather than `data`, `result`, or `temp` when a precise name is available.
Short conventional names are fine in small scopes.

Name booleans as predicates (`isReady`, `hasReview`, `canRetry`). Use named options
instead of ambiguous positional booleans.

## Functions and control flow

Each function should perform one coherent operation. Extract functions for a
meaningful concept, not a line-count target. Keep related steps together.

Use guard clauses and early returns to keep the happy path clear. Avoid deep
nesting and nested ternaries. Use `switch` for explicit states and handle
discriminated unions exhaustively. Use an options object for related parameters.

Prefer pure functions where practical. Make side effects clear in names and keep
them near system boundaries.

## TypeScript

Infer obvious local types. Explicitly type exported APIs, domain models,
configuration, backend contracts, and persisted or external data boundaries.
Validate external values before treating them as domain types.

Prefer `unknown` to `any`; contain genuinely untyped integrations at their
boundary. Narrow types instead of using assertions or non-null assertions.
Model mutually exclusive task and run states with discriminated unions.

Prefer `type`; use `interface` when its extension or merging semantics are needed.
Prefer string unions or const objects to enums. Keep runtime TypeScript compatible
with Node's type stripping and the repository's `erasableSyntaxOnly` setting.
Use explicit `.ts` extensions for TypeScript imports and `node:` for Node built-ins.

## Collections and mutation

Use `map`, `filter`, `find`, `some`, or `every` when they express the operation
clearly. Use loops when they are easier to follow. Name intermediate values
instead of building long transformation chains.

Do not mutate arguments unless the API explicitly promises mutation. Local
mutation is fine when it makes an algorithm clearer or more efficient.

## Async code and errors

Prefer `async` / `await`. Await promises or give background work explicit error
handling and lifecycle ownership. Respect cancellation and release timers,
listeners, processes, and workspaces when their owner finishes.

Catch errors where recovery, translation, or useful reporting can happen. Never
silently swallow failures or catch only to rethrow. Include actionable context
and preserve the cause when wrapping an error. Model expected domain failures
explicitly when callers must handle them. Do not include credentials in errors
or logs.

## Modules and abstraction

Give each module a clear domain responsibility. Keep related behavior close,
prefer named exports, and avoid circular dependencies. Use barrels only for an
intentional public API; avoid generic `utils.ts` or `helpers.ts` dumping grounds.

Inspect existing patterns before adding abstractions. Share code when callers
share a concept and a reason to change, not merely similar syntax. A little
duplication is better than a speculative factory, wrapper, or compatibility layer.
Prefer platform APIs and existing dependencies to new dependencies for trivial work.

## Comments and tests

Comments should explain constraints, invariants, tradeoffs, and why something is
surprising. Do not narrate obvious code. TODOs should identify concrete remaining
work.

Test observable behavior with descriptive names and explicit setup. Use scripted
providers for deterministic engine tests. Put shared backend contracts in the
existing conformance suite. Cover failure, cancellation, and recovery when the
change affects those paths. Do not weaken production types to simplify a test.

## Before finishing

Format changed files, run `npm run check`, and run relevant tests. Review the diff
for unnecessary complexity. Use additional smoke or benchmark checks when the
change affects packaging, runtime integration, or performance. The result should
be the smallest clear implementation that satisfies the requirement.
