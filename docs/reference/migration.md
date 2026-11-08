# Version 3 migration

This is a breaking behavioral/API release. Convert inputs explicitly:

```sh
pinata migrate old-job.json --output job-v3.json
pinata migrate old-config.json --output config-v3.json
pinata migrate old-agent.md --output agent-v2.md
```

Output files are created exclusively; originals are preserved. Without `--output`, converted
content goes to stdout and notices to stderr. Job schema is 3, definition schema is 2,
run-record schema is 3, and new events use version 2. Old event logs remain readable.

The converter removes limits, deadlines, review policy, ownership and automatic check
fields. Useful ownership and check intent becomes assignment/coordinator instructions,
with notices that it is no longer enforced. Legacy builder jobs and definitions retain
explicit worktree isolation during conversion; choose shared deliberately when adapting
them to the new workflow. Read-only definitions retain read access. No conversion grants
additional tools. Automatic verified delivery becomes manual application.

Legacy runs cannot resume under the new runtime. Preserve or stop their original workers
before starting converted work. Saved legacy patches can be inspected independently of
whole-run success and explicitly applied using current path/object validation, destination
gates and conflict checks. Old review/check receipts remain historical; they do not certify
new edits, combined changes or the current destination.
