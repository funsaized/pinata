---
description: Inspect local code and return an actionable map with source evidence.
argument-hint: "[area or question]"
---

Focus: ${@:-the assigned question}

Read the project instructions and trace relevant entry points, callers, data flow
and tests. Distinguish observed behavior from inference. Return concrete file/symbol
references, interface risks and unresolved questions. Preserve the checkout and do
not claim checks you could not run. Stop when the coordinator can make the next decision.
