# Mirror npm releases to GitHub Packages

Commands on this page are _manual_: they publish, authenticate or need registry access.

npm is the release source. The GitHub mirror downloads an already-published
`pi-pinata` version and publishes it as `@funsaized/pi-pinata`. GitHub requires
the scope; the name on npm stays `pi-pinata`.

The mirror changes only `package.json`'s name and JSON formatting. It checks
file contents, executable bits, and the remaining metadata before publication,
then downloads the GitHub package and checks them again. It does not rebuild
from the current branch, run package lifecycle scripts, or publish to npm.

The [release workflow](../../.github/workflows/release.yml) calls this mirror
automatically after publishing and verifying each npm release.

## Run a sync

The [sync workflow](../../.github/workflows/sync-github-package.yml) checks npm's
`latest` version daily at 07:23 UTC. Scheduled runs can be delayed by GitHub.
To mirror a release immediately:

```sh
gh workflow run sync-github-package.yml --ref master -f version=0.2.0
gh run list --workflow sync-github-package.yml --limit 5
gh run watch RUN_ID --exit-status
```

Replace `0.2.0` with the published version and `RUN_ID` with the dispatched run.
Use `-f version=latest` to resolve npm's current `latest` tag. You can also use
**Actions → Sync npm package to GitHub → Run workflow** in the repository.

The final log should contain:

```json
{
  "package": "@funsaized/pi-pinata",
  "version": "0.2.0",
  "published": true,
  "verified": true
}
```

A repeat run reports `published: false` and verifies the existing artifact
instead of republishing. A version with different contents fails verification;
the workflow does not overwrite or delete it.

## Permissions and visibility

The job uses its short-lived `GITHUB_TOKEN` with `contents: read` and
`packages: write`. No npm publishing token or long-lived GitHub secret is needed.
The package's repository field links it to `funsaized/pinata`.

GitHub makes a new package private by default. To make it publicly visible,
open the package under the repository's **Packages** section, then use
**Package settings → Change visibility**. Making a package public is permanent;
confirm that you intend public distribution first. The workflow does not change
visibility.

GitHub's npm registry requires authentication even for public packages. Most
users should keep installing from npm with `pi install npm:pi-pinata`.

## Install from GitHub instead

For a local install, authenticate with a classic personal access token that has
`read:packages`, plus access to the package if it is private. Enter the token
only at the password prompt; do not put it in the command or commit it.

```sh
npm login --scope=@funsaized --auth-type=legacy --registry=https://npm.pkg.github.com
pi install npm:@funsaized/pi-pinata
```

This configures npm's registry mapping for the scope and installs into your
personal Pi configuration. Restart Pi or run `/reload`. Do not install both
copies into the same Pi configuration: they provide the same skill and prompt
names. Use [platforms](../how-to/platforms.md) to remove the old source and check collisions.

## Tags and missed versions

A newly mirrored version gets GitHub's `latest` tag only if it is npm's current
`latest`. An explicit older or prerelease version uses `mirror` instead, so a
backfill cannot move `latest` backwards. If npm explicitly marks a prerelease
as `latest`, the mirror follows that choice.

The daily job copies the current `latest`, not every version published since
its last run. Dispatch missed versions individually. Existing versions are
verified without changing tags. This is a version-content mirror, not a copy
of all npm dist-tags or deprecations.

## Recover a failure

- Authentication or network failures stop the run. Check Actions permissions
  and the package's repository access before retrying. A registry 404 can also
  hide a package this repository cannot access; a failed publish is not grounds
  to delete an existing package.
- After an ambiguous publish response, rerun the same version. The workflow
  checks whether it exists and verifies its contents before declaring success.
- A content mismatch requires investigation. Do not delete and recreate a
  version to hide it; publish a corrective npm release when needed.
- If upstream adds `publishConfig`, the mirror stops for review rather than
  risk publishing to a registry selected by package metadata.

The helper and its offline regression check live in the repository checkout,
not the published package. Run `node --test test/github-package.test.mjs` to
check first publication, repeat runs, authentication failures, input validation,
backfill tags, and mismatched artifacts without contacting a registry.

Sources: [GitHub npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry),
[package visibility and access](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

[Publish to npm](publication.md) · [Documentation index](../README.md)
