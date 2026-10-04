# Publish pinata to npm

How to release `pi-pinata` to npm once you have explicit authorization. Nothing
on this page authorizes a commit, push, tag, publication, or deployment by
itself. Recorded test results are in [validation](validation.md); the local test
commands are in [testing](testing.md).

Package: **pi-pinata**. Publisher: **funsaized**
([npm profile](https://www.npmjs.com/~funsaized)). Repository:
<https://github.com/funsaized/pinata>. Initial version: 0.1.0, MIT. There are no
runtime npm dependencies.

Record the approved action and target before proceeding. Never log npm tokens
or read credential files to check identity.

## Inspect and pack

```sh
npm ci --ignore-scripts
npm test
npm run test:pi
npm run lint
npm run format:check
npm pack --dry-run --json --ignore-scripts
```

Review the included paths. You should see only package metadata, README/LICENSE,
the two skills, five prompt templates, runtime modules, docs, and examples. There
should be no run state, logs, tests, PLAN.md, .git, node_modules, secrets, or
other development debris.

For a real local artifact, use `npm pack --ignore-scripts`. That creates an
ignored tarball, not a publication. The Pi smoke test already exercises a tarball
in a scratch npm prefix and isolated agent directory.

## Recheck name and account immediately before publishing

```sh
npm view pi-pinata name version maintainers --json
npm whoami
```

An E404 only says the registry did not return the name. It does not guarantee
availability or reserve it. If a different project or account occupies the name,
**stop and ask**. If this project has already published it, inspect existing
versions and maintainers before an authorized version bump. Confirm `npm whoami`
is exactly `funsaized`, and authenticate interactively only with permission.

Version 0.1.0 is published on npm. Recheck the registry before choosing the next
version; published versions cannot be replaced.

## Authorized release only

After reviewing the exact packed artifact, version, staged diff (if committing),
and action-specific authorization:

```sh
npm publish ./pi-pinata-0.1.0.tgz --access public
```

Use the actual inspected tarball and version, not a stale filename. Follow npm's
current MFA and trusted-publishing requirements. Do not bypass Git hooks or
invent account credentials. Git pushes, tags, and PRs remain separately
authorized actions.

Verify registry metadata, then inspect a fresh download of the published version:

```sh
npm view pi-pinata@0.1.0 version dist.integrity repository maintainers --json
RELEASE_CHECK=$(mktemp -d)
npm pack pi-pinata@0.1.0 --pack-destination "$RELEASE_CHECK" --ignore-scripts
tar -tzf "$RELEASE_CHECK/pi-pinata-0.1.0.tgz"
npm install --prefix "$RELEASE_CHECK/install" --ignore-scripts "$RELEASE_CHECK/pi-pinata-0.1.0.tgz"
PI_CODING_AGENT_DIR="$RELEASE_CHECK/pi-agent" pi install "$RELEASE_CHECK/install/node_modules/pi-pinata" --no-approve
PI_CODING_AGENT_DIR="$RELEASE_CHECK/pi-agent" node "$RELEASE_CHECK/install/node_modules/pi-pinata/lib/pinata.mjs" resources "$RELEASE_CHECK"
```

Use the version you actually published in every command. Check that the file
list matches the approved artifact and the resource probe returns `ok: true`.
The temporary Pi agent directory keeps this verification out of personal config.

Record the output and the tested install path. If publication returns an
ambiguous result, inspect the registry first. Do not blindly retry or bump a
version.

npm versions are not overwriteable. A rollback normally means an explicitly
authorized corrective version and, where appropriate, deprecation. Do not
automatically unpublish or change dist-tags. Record a rollback plan before
publication and verify its actual outcome if you use it.

## Sync the GitHub mirror

After npm publication, [sync that version to GitHub Packages](github-packages.md).
The daily workflow mirrors npm's current `latest`; a manual dispatch can copy a
specific published version immediately. It uses `@funsaized/pi-pinata` on GitHub
and keeps the unscoped npm package unchanged.

## Removal

Use `pi remove npm:pi-pinata`, or the exact registered local path for a local
installation. Resolve active runs before removing helper files. Package removal
does not delete user work or run evidence. The isolated removal check is recorded
in [validation](validation.md); follow [run cleanup](recovery.md#cancel-and-clean-up)
before removing an active installation.

---

Part of the [pinata documentation](README.md). Related: [validation](validation.md),
[testing](testing.md), [architecture](architecture.md#trust-and-safety).
