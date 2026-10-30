# Pinata backlog

Pi stays small. Your subagent system should too.

Keep the engine focused on definitions, tasks, efficient execution, and inspectable
results. Ship scout, builder, and reviewer; demonstrate customization through the
optional planner and researcher examples.

Future changes need a concrete workflow and measured benefit. In particular, do not
add a workflow language, agent marketplace, executable profile hooks, recursive agent
hierarchies, or a separate provider stack merely for generality.

Measure before raising the active concurrency ceiling. Current limits are per engine;
independent Pi hosts do not share a machine-wide scheduler. Track provider latency
separately from local scheduling and startup overhead.

Extension entry hashes do not freeze transitive dependencies. Broader reproducibility
or cross-host coordination needs an actual use case before expanding the runtime.
