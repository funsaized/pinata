# Publish Pinata to npm

Commands on this page are _manual_: they publish, authenticate or need registry access.

Release `pi-pinata` through a reviewed release branch and a version tag. Use these
steps with authorization for the specific commits, pushes, tags, publications, or
deployments you intend. Record the [local test results](testing.md)
in the release pull request.

The npm package is `pi-pinata`, published by
[funsaized](https://www.npmjs.com/~funsaized) from
<https://github.com/funsaized/pinata>. It is MIT licensed and has no runtime npm
dependencies.

Record the approved action and target before proceeding. Never log npm tokens
or read credential files to check identity.

## Automated release

The [release workflow](../../.github/workflows/release.yml) runs when you push a
`vX.Y.Z` tag. Bump `package.json` and `package-lock.json` on a release branch, run
the checks below (including the real Pi smoke test), and merge the reviewed pull
request into `master` once CI passes. Then push a tag for that merge commit:

```sh
RELEASE_VERSION="<version>"
npm version "$RELEASE_VERSION" --no-git-tag-version
# Commit on a release branch, open a PR, and merge it once CI is green.
git fetch origin
git push origin "origin/master:refs/tags/v${RELEASE_VERSION}"
```

Replace `<version>` with the release version and use it throughout these commands. A `vX.Y.Z` tag publishes to npm's
`latest`; a `vX.Y.Z-next.N` tag publishes to `next` only and creates a GitHub
prerelease. CI runs unit tests and formatting/lint
checks, validates the tag, lockfile, package identity, and packed paths, then
publishes the exact tarball with provenance using the repository's `NPM_TOKEN`
secret. The token must belong to `funsaized` and permit publication of `pi-pinata`.
CI checks the npm integrity hash before calling the GitHub Packages mirror for
the same version. After both registries succeed, CI creates the GitHub release for
the tag with generated notes, unless one already exists; edit its notes afterward
if needed. It does not require a Herdr server or model credentials.

For a failed run, inspect its result before retrying. The workflow can also be
manually dispatched against an existing release tag:

```sh
gh workflow run release.yml --ref master -f tag="v${RELEASE_VERSION}"
```

A version already on npm is accepted only when its integrity matches the local
packed artifact. A failed mirror can be retried independently using the sync
workflow below. Never move a published release tag or overwrite a package version.

## Inspect and pack

```sh
npm ci --ignore-scripts
npm run check
npm test
node test/engine/pi-smoke.ts
node test/engine/package-smoke.ts
npm pack --dry-run --json --ignore-scripts
```

Inspect the file list. It should contain package metadata, README/LICENSE,
the packaged skills (subagents registered by default), five prompt templates, three agent
presets, optional agent examples, runtime modules, and docs. There
should be no run state, logs, tests, .git, node_modules, secrets, or other
development files.

For a local artifact, use `npm pack --ignore-scripts`. It creates an ignored
tarball for inspection. Publishing is a separate step below. The Pi smoke test already exercises a tarball
in a scratch npm prefix and isolated agent directory.

## Check the package name and publisher

```sh
npm view pi-pinata name version maintainers --json
npm whoami
```

If npm returns E404, the name was not returned; it is not reserved or guaranteed
available. Stop and ask if a different project or account occupies it. For an
existing Pinata package, inspect its versions and maintainers before bumping the
version. `npm whoami` must return `funsaized`. Authenticate interactively only
with permission.

Recheck the registry before choosing the next version; published versions cannot be replaced.

## Publish the inspected artifact

Confirm that the packed artifact, version, and authorized action match. Review the
staged diff too if committing, then publish the inspected tarball:

```sh
npm publish "./pi-pinata-${RELEASE_VERSION}.tgz" --access public
```

Use the version you inspected. Follow npm's current MFA and trusted-publishing
requirements, keep Git hooks enabled, and use valid account credentials. Git pushes,
tags, and PRs each need authorization for that action.

Verify registry metadata, then inspect a fresh download of the published version:

```sh
npm view "pi-pinata@${RELEASE_VERSION}" version dist.integrity repository maintainers --json
RELEASE_CHECK=$(mktemp -d)
npm pack "pi-pinata@${RELEASE_VERSION}" --pack-destination "$RELEASE_CHECK" --ignore-scripts
tar -tzf "$RELEASE_CHECK/pi-pinata-${RELEASE_VERSION}.tgz"
npm install --prefix "$RELEASE_CHECK/install" --ignore-scripts "$RELEASE_CHECK/pi-pinata-${RELEASE_VERSION}.tgz"
PI_CODING_AGENT_DIR="$RELEASE_CHECK/pi-agent" pi install "$RELEASE_CHECK/install/node_modules/pi-pinata" --no-approve
node "$RELEASE_CHECK/install/node_modules/pi-pinata/bin/pinata.mjs" help
```

Use the version you actually published in every command. Check that the file
list matches the approved artifact and the `pinata` command prints its usage.
The temporary Pi agent directory keeps this verification out of personal config.

Record the output and tested install path. If the publication result is unclear,
check the registry before retrying or choosing another version.

npm versions cannot be overwritten. Plan for a corrective release and, if appropriate,
deprecation before publishing. Those actions need explicit authorization, as do
unpublishing or changing dist-tags. If you use the rollback plan, verify its outcome.

## Sync the GitHub mirror

After npm publication, [sync that version to GitHub Packages](github-packages.md).
The release workflow mirrors its version immediately after npm verification.
The daily workflow also mirrors npm's current `latest`; a manual dispatch can
copy a specific published version. It uses `@funsaized/pi-pinata` on GitHub
and keeps the unscoped npm package unchanged.

## Removal

Use `pi remove npm:pi-pinata`, or the exact registered local path for a local
installation. Let active runs settle (or cancel them) first. User work and run
evidence remain after package removal. Follow [run cleanup](../how-to/recover.md)
before removing an active installation.

---

Part of the [pinata documentation](../README.md). Related: [testing](testing.md),
[GitHub Packages](github-packages.md), [trust and safety](../explanation/trust.md).
