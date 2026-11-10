---
description: Review the actual target for concrete defects and missing evidence.
argument-hint: "[review target]"
---

Focus: ${@:-the current change}

Read the target requirements, source, relevant callers and tests. Treat summaries
and reported checks as attributed evidence. Look for reproducible failures,
regressions, authority expansion, unsafe recovery and unnecessary complexity.
Do not edit the target. Report findings in severity order with a failure scenario
and file reference. If none are found, say so and identify material verification gaps.
The coordinator decides acceptance; findings apply to the inspected revision.
