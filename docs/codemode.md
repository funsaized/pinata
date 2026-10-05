# Use codemode in workers

Pi's [codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md)
tool lets a model write one JavaScript script that calls its other tools in
parallel and returns only the filtered output. pinata enables it for every
worker by default. In the recorded live run, a reviewer made 16 reads in 4
turns. This guide covers when to change that and how to bound it.

## Check that workers use it

Each attempt's `outcome.json` records `toolCalls`, which counts every tool
call, including calls made inside codemode scripts. To see the breakdown, count
`tool_execution_start` events by `toolName` in the attempt's `pi.stdout.log`.
A `codemode` entry means the worker batched calls.

## Turn it off

```json
"config": { "codemode": false }
```

Turn it off for models that write poor JavaScript or that ignore the tool, or
to compare runs. Without codemode, raise `limits.maxTurns`, because each tool
call then needs its own turn. [no-codemode.json](../examples/configs/no-codemode.json)
shows both settings together.

## Bound tool use

Codemode packs many calls into one turn, so `maxTurns` alone no longer limits
the work. `limits.maxToolCalls` (default 400) stops a worker whose total calls
exceed it. The outcome then fails with `tool call budget exceeded`.

```json
"config": { "limits": { "maxTurns": 60, "maxToolCalls": 200 } }
```

Neither limit caps spending. Set monetary limits with your provider.

## Choose how tools are presented

Codemode reads `codemode.mode` from your Pi `settings.json`. With `on` (the
default) workers see their tools directly and through codemode. With `only`,
their tools are reachable only through scripts. pinata does not override this
setting.

## What stays the same

- **Tool access.** A script can call only the tools its role already has. A
  scout's script sees `read`, `grep`, `find`, and `ls`, and gets
  `tools.bash does not exist` if it asks for more. `npm run test:pi` checks this
  against real Pi on every run.
- **Evidence.** The supervisor still compares reported changes with the real
  worktree and reruns the approved checks itself.
- **Privacy.** Large script output goes to a temporary file. pinata points
  `TMPDIR` at the attempt's private `tmp/` directory, so those files stay in the
  run directory with mode `0700` instead of the shared `/tmp`.

One addition to watch: scripts can call `models.classify()` and
`models.generateImages()` with your credentials. The worker brief tells workers
not to, but that is an instruction, not enforcement. Disable codemode if that
spending path is unacceptable.

Related: [tools by role](configuration.md#tools-by-role) ·
[trust and safety](architecture.md#trust-and-safety) ·
[Documentation index](README.md)
