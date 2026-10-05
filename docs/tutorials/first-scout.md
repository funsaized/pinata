# Run your first scout

You will create a tiny Git repository, ask a scout to inspect it, and read the
result. The scout will not change project files. pinata will create private run
state, a worktree, and a Herdr workspace.

Allow about ten minutes after [setup](../setup.md). You need a working Herdr
session and an approved, authenticated model. This tutorial makes real model
calls, which may cost money. It does not need web access or npm dependencies.

## 1. Create a practice repository

Use a new directory, not an existing project. In your terminal:

```sh
mkdir pinata-playground
cd pinata-playground
git init
```

Create `greet.mjs` in your editor:

```js
export const greet = (name) => `Hello, ${name}!`;
```

Create `greet.test.mjs` beside it:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { greet } from "./greet.mjs";

test("greets a name", () => {
  assert.equal(greet("Ada"), "Hello, Ada!");
});
```

Run the test, then record the starting commit in this practice repository:

```sh
node --test greet.test.mjs
git add greet.mjs greet.test.mjs
git commit -m "test: add greeting fixture"
git status --short
```

You should see one passing test and a clean working tree. If the commit fails
because Git identity is missing, configure it yourself before continuing.
Workers need an existing commit; do not skip this checkpoint.

## 2. Prepare a scout job

Open [scout-job.json](../../examples/scout-job.json). Save a copy outside the
practice repository, for example beside its directory. Keeping job files outside
the project avoids making them part of the inspected repository.

Edit these values:

- `cwd`: the absolute path to `pinata-playground`.
- `approval`: your actual approval for this read-only task and model usage.
- `config.models.default`: the provider, model ID, and supported thinking level
  you checked during setup.
- `config.session`: add this field with your existing Herdr session name if you
  are not running inside its pane.

The task asks the scout to explain whitespace handling and suggest a regression
test. Leave `allowWrites` as `false`.

Set the installed helper and saved job paths in the same terminal:

```sh
PINATA=/absolute/installed/package/lib/pinata.mjs
JOB=/absolute/path/to/scout-job.json
node "$PINATA" init "$JOB"
```

The output contains a `run` directory, an `id`, detected versions, and a
`setup` entry. The practice repository has no lockfile, so `setup.source` is
`none`; scouts do not run setup anyway. Copy the
`run` value into a variable:

```sh
RUN=/absolute/run/path/from/the/output
node "$PINATA" status "$RUN"
```

The `scout` task should be `queued`. Initialization records the job; it does not
launch the worker yet. If preflight fails, fix the reported prerequisite before
trying again. Do not replace a real model with a guessed identifier.

## 3. Launch and wait

```sh
node "$PINATA" wait "$RUN" 30000
```

This starts ready work and waits for up to 30 seconds. If the output includes
`waiting: true`, repeat the same command. Do not treat the observation timeout
as a finished task.

Once the task reports `succeeded`, verify its evidence:

```sh
node "$PINATA" barrier "$RUN" scout
```

The barrier should succeed. If the task is `blocked`, `failed`, or `uncertain`,
read its error and outcome instead of continuing as if it passed. The
[recovery guide](../recovery.md) covers those states.

## 4. Read the result

The status output includes a `result` path ending in `outcome.json`. Open it in
your editor and read `result.brief` inside that file.

The wording depends on the model. Check that it:

- Points to `greet.mjs` and the existing test.
- Explains that `greet(" Ada ")` currently returns `"Hello,  Ada !"`.
- Suggests a whitespace regression test without claiming to have run it.

The result should have no changed files. Confirm the original repository remains
clean with `git status --short`. A successful status validates the run evidence;
you still need to read whether the answer is useful.

## 5. Close the workspace

```sh
node "$PINATA" cleanup "$RUN"
```

Inspect the preview. If it identifies only the practice run's idle resources,
approve their removal:

```sh
node "$PINATA" cleanup "$RUN" --confirm
```

Logs and the manifest remain. Dirty or uncertain worktrees are retained, not
force-removed. There is nothing to integrate because the scout made no changes.

You now have a run path, a validated outcome, and a clean practice repository.
Keep the repository for [Build and review a change](build-and-review.md).

[Agent examples](../../examples/README.md) · [Documentation index](../README.md)
