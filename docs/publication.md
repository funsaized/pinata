# Publication (manual authorization required)

Package: **pi-pinata**. Publisher: **funsaized**
([npm profile](https://www.npmjs.com/~funsaized)).
Repository: <https://github.com/funsaized/pinata>.
Initial version: 0.1.0, MIT. There are no runtime npm dependencies.

An implementation approval does not authorize a commit, push, tag, package
publication, or production deployment. Record explicit action/target authorization
before those operations. Never log npm tokens or read credential files to check
identity.

## Inspect and pack

```sh
npm ci --ignore-scripts
npm test
npm run test:pi
npm run lint
npm run format:check
npm pack --dry-run --json --ignore-scripts
```

Review included paths: only package metadata, README/LICENSE, the two skills,
five prompt templates, runtime modules, docs, and examples. No run state, logs,
tests, PLAN.md, .git, node_modules, secrets, or other development debris.

For a real local artifact, use `npm pack --ignore-scripts`. This creates an
ignored tarball, not a publication. The Pi smoke test already exercises a tarball
in a scratch npm prefix and isolated agent directory.

## Recheck name and account immediately before publishing

```sh
npm view pi-pinata name version maintainers --json
npm whoami
```

An E404 only says the registry did not return the name; it does not guarantee
availability or reserve it. If occupied by a different project/account, **stop
and ask**. If already published by this project, inspect existing versions and
maintainers before an authorized version bump. Confirm `npm whoami` is exactly
`funsaized`; authenticate interactively only with permission.

The first registry check on 2026-10-04 returned E404. Rechecking is mandatory:
that observation can become stale at any time.

## Authorized release only

After reviewing the exact packed artifact, version, staged diff (if committing),
and action-specific authorization:

```sh
npm publish ./pi-pinata-0.1.0.tgz --access public
```

Use the actual inspected tarball/version, not a stale filename. Follow npm's
current MFA/trusted-publishing requirements. Do not bypass Git hooks or invent
account credentials. Git pushes/tags/PRs remain separately authorized actions.

Verify registry version, files/integrity, repository metadata, maintainers, and a
fresh isolated install:

```sh
npm view pi-pinata@0.1.0 version dist.integrity maintainers --json
```

Record the output and tested install path. If publication returns ambiguously,
inspect the registry first; do not blindly retry or bump a version.

npm versions are not overwriteable. A rollback normally means an explicitly
authorized corrective version and, where appropriate, deprecation. Do not
automatically unpublish or change dist-tags. Record a rollback plan before
publication and verify its actual outcome if used.

## Removal

Use `pi remove npm:pi-pinata`, or the exact registered local path for a local
installation. Resolve active runs before removing helper files. Package removal
does not delete user work or run evidence.
