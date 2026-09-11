# Releasing the six native CLI builds

Releases are explicit maintainer operations, not a side effect of pushing source.
The only release trigger is `workflow_dispatch` in
`.github/workflows/release-cli.yml`. Do not overwrite an existing tag or Release.

## Prepare a version

1. Select the next fork version without changing the upstream product baseline.
   The currently prepared version is `1.18.4-zhcn.2`, using Bun `1.4.2` with
   bytecode and embedded WebUI. It remains an unsigned prerelease.
2. Update the selected version/runtime in `packages/cli/script/release-contract.ts`
   and the corresponding workflow input, tag, runtime pins and focused tests.
   Do not relabel previously published assets.
3. Run the package-local release tests, CLI typecheck, workflow lint, and public
   content review. Obtain approval for the complete candidate before dispatch.
4. Push the reviewed source to public `main` and verify its exact commit.

## Run the workflow

An authorized maintainer can select **Actions → Release fork CLI binaries → Run
workflow**, select `main`, and enter the prepared version. The CLI equivalent is:

```sh
gh workflow run release-cli.yml --repo 521ox/opencode2-zh-CN --ref main -f version=1.18.4-zhcn.2
gh run watch <run-id> --repo 521ox/opencode2-zh-CN --exit-status
```

Verify that the run's `head_sha` is the reviewed commit. A dispatch is not a
successful release. Do not dispatch again merely because its response was lost;
inspect existing runs first. The owner may cancel a run before publication.

## Build and publication gates

The workflow uses six native runners: Windows x64 and ARM64, Linux glibc x64
and ARM64, and macOS Intel x64 and Apple Silicon ARM64. Every runner installs
the frozen lockfile, builds one explicit target, and verifies:

- clean source and workspace-contained tracked symlinks;
- exact application version, embedded Bun revision matching the compiler, and
  a working help command;
- compiled artifact contents and isolated service startup/authentication/stop;
- an archive and schema-v2 sidecar binding the commit, runtime, bytecode option,
  platform, executable/archive lengths, and SHA-256 values.

Only after all six jobs succeed does the final job validate the complete set,
create `release-manifest.json` and `SHA256SUMS`, upload a draft, check all 14
assets, and publish the prerelease. A failed or missing platform prevents the
Release. GitHub also provides source archives separately from these 14 assets.

After publication, independently download and verify the assets, then update
the README and supported-release documentation to the version actually
published. Retain the old Release as a rollback option. Windows/macOS signing,
installers, stable status, and an application auto-updater are not provided by
this workflow. A published defect should normally be corrected in a new version,
not by silently replacing bytes under an existing tag.
