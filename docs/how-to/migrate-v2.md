# Migrate to Pinata v2

Pi stays small. Your subagent system should too.

The presets are now `scout`, `builder`, and `reviewer`. Planner and researcher are
optional [agent examples](agents.md). Copy the examples you use into your personal or
repository agent directory. `research` is now named `researcher`.

Use `agent` instead of `role` in new jobs. Existing preset jobs using `role` still work
with a deprecation notice. New legacy planner/research jobs require the corresponding
example to be installed; Pinata never silently activates it. Historical v1.1 runs keep
their saved role semantics and verification evidence.

Change config model/fallback keys from `research` to `researcher`. Other agent names
can be configured directly. See [configuration](../reference/config.md).

Simple read-only tasks can omit acceptance criteria. Common result arrays can be
omitted by new definitions and normalize to empty arrays. Writer ownership, check
requirements, approval, review-target binding, and exact integration protections remain.
A completed task, passing checks, an approving artifact review, and destination
verification are separate facts.

The engineering-management skill remains packaged at `skills/engmgmt`, but is no
longer automatically registered. Add that skill explicitly if you want the recipe.
Planner/research prompt templates are no longer registered; use the example definitions.

Run `pinata agents validate` and inspect your agent list before running migrated jobs.
To use an edited definition for a historical task, start a new run. Continuing or repairing
an existing run intentionally keeps its saved definition.
