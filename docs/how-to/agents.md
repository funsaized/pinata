# Create an agent

Pinata includes `scout`, `builder`, and `reviewer`. Ask Pi to create an agent when
you want to reuse more specific instructions:

```text
Create an agent called api-scout for this repository. Give it read-only tools.
It should find an API's entry points, callers, error handling, and tests, then
return a short brief with file references and unanswered questions.
Save it in .pi/pinata/agents/api-scout.md so I can use it in future tasks.
```

Pi saves the agent's instructions and defaults in a Markdown definition. You can
edit that file or ask Pi to change it. The definition is reusable; each task gives
the agent a specific job.

## The agent file

Save definitions in either directory:

- `<Pi agent directory>/pinata/agents/` (normally `~/.pi/agent/pinata/agents/`)
- `<repository>/.pi/pinata/agents/`

Repository definitions override personal ones with the same name. Duplicate names
within one directory are errors. Built-in names are reserved, so use a new name
when customizing a built-in agent.

The request above produces a definition like this. You can also save it yourself
as `.pi/pinata/agents/api-scout.md`:

```markdown
---
schemaVersion: 1
name: api-scout
description: Map API boundaries and their tests.
workspace: live-readonly
tools: [read, grep, find, ls]
output:
  require: [brief]
---

Find the entry points, callers, error handling, and tests for the assigned API.
Return a concise brief with file references and unresolved questions.
```

## Use agents together

Once `api-scout` is saved, ask Pi to use it alongside other agents. For example,
here is a bug fix with two parallel investigations, a builder, and a review.
Replace the paths and test command with ones from your repository.

```text
Fix the bug where requests without a token can reach a protected endpoint.

First, have api-scout trace the authentication flow in src/auth.mjs. At the same
time, have a scout inspect test/auth.test.mjs for missing-token coverage.

When both finish, have a builder use their findings to fix the bug and add a
regression test. It may edit src/auth.mjs and test/auth.test.mjs and run npm test.
Requests without a token should return 401; valid tokens should still work.

Then have an independent reviewer check the patch and test results against those
requirements. Stop after review so I can inspect the changes before applying them.
```

Pi turns this request into tasks and their dependencies. The builder receives both
scouts' findings. The reviewer gets the builder's actual patch and check results.

### The corresponding tool call

For the request above, `pinata_run` would look like this:

```json
{
  "approval": "The user authorized edits to src/auth.mjs and test/auth.test.mjs and running npm test. Stop after review.",
  "tasks": [
    {
      "id": "map-auth",
      "agent": "api-scout",
      "task": "Trace authentication in src/auth.mjs. Find how a request without a token reaches a protected endpoint. Cite the relevant code."
    },
    {
      "id": "map-tests",
      "agent": "scout",
      "task": "Inspect test/auth.test.mjs. Identify missing-token coverage and how to add a regression test using the existing test helpers. Cite the relevant code."
    },
    {
      "id": "fix-auth",
      "agent": "builder",
      "after": ["map-auth", "map-tests"],
      "task": "Use both scouts' findings to reject requests without a token at protected endpoints. Add a regression test and run npm test.",
      "acceptance": [
        "Requests without a token return 401 at protected endpoints.",
        "Requests with valid tokens still work.",
        "A regression test covers the missing-token case and npm test passes."
      ],
      "ownership": ["src/auth.mjs", "test/auth.test.mjs"],
      "checks": [{ "id": "tests", "argv": ["npm", "test"] }]
    },
    {
      "id": "review-auth",
      "agent": "reviewer",
      "after": ["fix-auth"],
      "reviewOf": "fix-auth",
      "task": "Review the patch against the builder's acceptance criteria. Check the authentication behavior, regression test, and recorded test results. Report concrete defects or approve the change."
    }
  ]
}
```

The two scouts have no `after` dependencies, so they can run in parallel. The
builder waits for both to succeed; the reviewer waits for the builder. A failed
task blocks its dependents. `reviewOf` tells the reviewer which patch to inspect.
The builder's `ownership` limits accepted changes to the two named files, and Pinata
runs `checks` in its worktree after it finishes. Applying the reviewed patch is a
separate step; see [build and review](../tutorials/build-and-review.md).

## Inspect your agents

Ask Pi to list available agents or show the instructions for `api-scout`.

Use `pinata_agents {}` to list definitions or `pinata_agents {"name":"api-scout"}`
to inspect one. Pinata reports the file it loaded and its content hash (digest).
From the CLI:

```sh
pinata agents list
pinata agents show scout
pinata agents validate
```

## Start from an example

Ask Pi to copy the included [planner](../../examples/agents/planner.md) or
[researcher](../../examples/agents/researcher.md) into your agent directory and adapt
its instructions, tools, or model defaults. You can also copy the file yourself from
the installed package or this repository into either directory above. Avoid
overwriting an existing definition. Pinata gives these names no special behavior.

The planner shows how to set task dependencies, assign files to writers, choose
verification commands, and identify risks when combining changes.

The researcher uses tools from pi-web-access and cites sources in its results.
Each source uses an HTTP(S) `url` or a repository-relative `path`, with `title`,
`supports`, and `applicability` fields. Use execution checks to verify runtime behavior.

For all definition fields, model precedence, results, and saved runs, see the
[agent reference](../reference/agents.md).
