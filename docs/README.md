# Documentation

New to pinata? Start with the scout tutorial. It uses a small local repository
and leaves your project files alone.

## Tutorials: learn by doing

- [Run your first scout](tutorials/first-scout.md): create a run, wait for a result,
  and inspect the evidence.
- [Build and review a change](tutorials/build-and-review.md): give a builder one
  file, require a reviewer, and integrate the approved result.

## How-to guides: finish a task

- [Set up pinata](setup.md): install resources, select models, and enable research.
- [Agent examples](../examples/README.md): adapt assignments for scout, research,
  planner, builder, and reviewer, plus a coordinated coding job.
- [Recover and clean up a run](recovery.md): handle interruptions, rejections,
  uncertain launches, cancellation, and rollback.
- [Run the tests](testing.md): use local fixtures or opt into Herdr and live checks.
- [Publish to npm](publication.md): inspect, publish, and verify an authorized release.
- [Mirror to GitHub Packages](github-packages.md): sync published npm versions and verify the mirror.

## Reference: look up a fact

- [Commands and configuration](configuration.md): CLI arguments, job and task
  fields, model selection, limits, results, and artifacts.
- [Command reference](commands.md): command signatures, effects, and exit behavior.
- [Recorded validation](validation.md): tested versions, coverage, and untested platforms.

## Explanation: understand the design

- [How pinata runs a job](architecture.md): coordinators and workers, dependencies,
  ownership, evidence, review fingerprints, and trust boundaries.

These pages follow [Diataxis](https://diataxis.fr/): tutorials teach a path,
how-to guides solve a task, reference pages define contracts, and explanations
describe why the parts work together.
