# Releasing the six native CLI builds

Releases are explicit maintainer operations, not a side effect of pushing source.
The only release trigger is `workflow_dispatch` in
`.github/workflows/release-cli.yml`. Do not overwrite an existing tag or Release.

## Current published release

[v1.18.4-zhcn.2](https://github.com/521ox/opencode2-zh-CN/releases/tag/v1.18.4-zhcn.2)
was published from `946cf3501b8c8c545735ba98366b5bf863ffae30` on channel
`zh-cn`, using Bun `1.4.2` (revision
`744846f844374847c902b5e7fd59b4342a51ef99`), bytecode enabled, and the full
embedded WebUI. The [release run](https://github.com/521ox/opencode2-zh-CN/actions/runs/34554678273)
completed successfully: all six native jobs and the final publication job passed
the gates below. All 14 uploaded assets were then downloaded and verified against
GitHub digests, the manifest, and checksums, including archive executable/package
contents and PE/ELF/Mach-O platform architectures. This is bounded release
evidence, not a general stability guarantee.

The versioned tag and artifacts remain bound to that source commit. Later `main`
documentation commits do not change their source SHA or published bytes.
Historical `v1.18.4-zhcn.1` archives remain unchanged, built with Bun 1.3.14,
and available as a rollback option.

## Prepare a future version

1. Select the next fork version without changing the upstream product baseline.
   The last selected version, `1.18.4-zhcn.2`, is already published. Select and
   review a new version explicitly; there is no automatic version bump. The
   release uses Bun `1.4.2` with bytecode and embedded WebUI and remains an
   unsigned prerelease unless an authorized policy change says otherwise.
2. Update the selected version/runtime in `packages/cli/script/release-contract.ts`
   and the corresponding workflow input, tag, runtime pins and focused tests.
   Do not relabel previously published assets.
3. Run the package-local release tests, CLI typecheck, workflow lint, and public
   content review. Obtain approval for the complete candidate before dispatch.
4. Push the reviewed source to public `main` and verify its exact commit.

## Run the workflow

An authorized maintainer can select **Actions → Release fork CLI binaries → Run
workflow**, select `main`, and enter the newly prepared version. The following
records the dispatch used for the published `.2` release, not a command to rerun:

```sh
gh workflow run release-cli.yml --repo 521ox/opencode2-zh-CN --ref main -f version=1.18.4-zhcn.2
gh run watch <run-id> --repo 521ox/opencode2-zh-CN --exit-status
```

Rerunning with the existing `.2` tag or Release is refused, not an update path.
For a future release, replace the version only after completing preparation and
obtaining approval for that exact candidate.

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
