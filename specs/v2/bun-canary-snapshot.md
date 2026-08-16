# Pinned Bun Canary Compile Runtime Record

Date: 2026-08-16

Outcome: approved for formal-branch fast-forward

## Product Decision

The fixed Windows release build defaults to an immutable Bun canary compile
runtime. It does not implicitly follow the moving `canary` release.

The Bun process that runs the build orchestration and the Bun executable that
performs `bun build --compile` are separate authorities:

- Build orchestrator in the approved candidate: Bun `1.3.14`.
- Verified direct compile runtime embedded by the approved candidate: Bun
  `1.4.0`, revision `1.4.0-canary.1+aec33f581`.

`PinnedCanary` is the default compile-runtime mode. `Current` remains the
stable-runtime recovery mode, and `MovingCanary` remains an explicit diagnostic
mode.

## Fixed References

- Formal branch before finalization: `native-responses-v2`.
- Formal branch head before finalization:
  `2f99b51291731f79786e0293492f40a4c4b31b8c`.
- Integration branch: `integrate/bun-1.4-canary-pinned`.
- Initial implementation commit:
  `3cfca2d3c` (`build(windows): pin Bun canary compile runtime`).
- Audit remediation commit:
  `8cc1a1033bc569359fa912211ccdc2d22a11353b`
  (`fix(build): fail closed on cache and provenance`).
- Final formal head: the commit containing this record.

The finalization action is a strict fast-forward of `native-responses-v2` to
the commit containing this record. Existing recovery branches remain unchanged.

## Immutable Snapshot

- Release name: `Canary (dbd320ccfa909053f95be9e1643d80d73286751f)`.
- Runtime version: `1.4.0`.
- Runtime revision: `1.4.0-canary.1+aec33f581`.
- Normal Windows x64 asset ID: `516562299`.
- Normal asset name: `bun-windows-x64.zip`.
- Normal archive SHA-256:
  `aebf834d6532e68bbe6a4ca6b918e0c76e963d2ae37ffb17aacb4f555f3b03e4`.
- Baseline Windows x64 asset ID: `516562416`.
- Baseline asset name: `bun-windows-x64-baseline.zip`.
- Baseline archive SHA-256:
  `c0dede7c9e546335e01b6390f66d8a97f7a1fc454d96ed2e05aeca0d45dc550c`.
- Extracted executable SHA-256 for both assets:
  `11ac1246f004de55fdeab3cb4b91385151357ce96dc69f1dfdc598b6dd7c3b74`.
- Persistent cache root:
  `%LOCALAPPDATA%\opencode-build\bun\1.4.0-canary.1-aec33f581`.

## Implementation Contract

The Windows build wrapper:

1. Resolves the requested compile-runtime mode before compilation.
2. Downloads pinned assets by immutable asset ID when the verified cache is
   absent.
3. Requires the executable, matching archive, and `snapshot.json` for every
   pinned cache hit.
4. Recomputes archive and executable SHA-256 values and verifies runtime
   version, revision, asset ID, asset name, and recorded metadata on every use.
5. Builds a fresh cache in a staging directory, verifies it completely, and
   only then publishes the cache directory.
6. Passes the verified direct executable path, exact compile target, and
   expected executable hash to the CLI build script.
7. Rejects direct-compiler use for multi-target builds, missing hashes, target
   mismatches, and release/direct-compiler ambiguity.
8. Restores all build and direct-compiler environment variables and the caller
   location on success or failure.
9. Captures Git HEAD and full porcelain status before and after the build. Any
   Git command failure or source-state change stops publication.
10. Writes source, runtime, asset, cache, candidate, WebUI, baseline, and service
    smoke evidence into the candidate sidecar.

## Verification Evidence

The accepted implementation passed the following applicable checks:

- CLI suite: 205 tests, 631 assertions.
- CLI, Core, Server, and TUI typechecks.
- Changed TypeScript oxlint with zero errors.
- PowerShell AST parsing.
- `git diff --check`.
- Default normal pinned-canary build with full WebUI and compiled service smoke.
- Explicit `Current` compile-runtime build.
- Baseline pinned-canary build.
- Fresh pinned cache creation and subsequent cache-hit builds.

The following fail-closed cases were injected and rejected before candidate
publication:

- A partial cache containing only a valid `bun.exe`.
- A cache with a corrupt archive and a valid executable.
- A cache with a mismatched snapshot asset ID.
- A `Current` runtime whose revision probe fails.
- A failing Git status command.
- A source HEAD change between the pre-build and post-build snapshots, even
  after compilation itself completed.

The error-path checks also confirmed restoration of all six governed environment
variables and the caller location. The source-change check left the publication
directory empty and did not modify the existing root executable.

## Independent Review

The initial independent review rejected the implementation for three blocking
fail-open paths:

1. Partial or corrupt pinned caches could be accepted.
2. Runtime-probe failures could leak modified environment state.
3. Source provenance could be sampled after the build or treat Git failures as
   a clean source state.

Commit `8cc1a1033bc569359fa912211ccdc2d22a11353b` closed those findings. The same
review session returned `APPROVE WITH DEFERRED RISKS` on 2026-08-16 and found no
new blocking regression in the remediation scope.

## Approved Candidate

- File:
  `D:\opencode2-zh-CN-bun-canary-final-approved\opencode2-zh-CN-1.18.4-windows-x64-20260816-165530.exe`.
- Sidecar: the same path with `.build.json` appended.
- Product version: `opencode2 v1.18.4`.
- Length: `198639104` bytes.
- Candidate SHA-256:
  `BA93CE81423FF1B9635061B78CCE2E40412974B5D8F864326495CCE44823F149`.
- Source commit recorded by the sidecar:
  `8cc1a1033bc569359fa912211ccdc2d22a11353b`.
- Source state recorded by the sidecar: clean, with an empty `SourceStatus`.
- Compile-runtime mode recorded by the sidecar: `PinnedCanary`.
- Compile-runtime cache result recorded by the sidecar: verified cache hit.
- Full WebUI: enabled.
- Baseline target: disabled.
- Compiled service smoke: passed.

The build script did not replace
`D:\opencode-zh-CN-nightly-windows-x64\opencode.exe`. Installation remains an
explicit operator action after the current process tree has exited.

## Recovery

- The existing Bun `1.3.14` candidate and installed binary remain available.
- Run the fixed build with `-CompileRuntime Current` to generate a
  stable-runtime fallback.
- Keep `integrate/bun-1.4-canary-pinned` as the bounded recovery reference.
- If the pinned cache is damaged or intentionally refreshed, remove that exact
  snapshot cache and rebuild; hash or metadata mismatches must fail closed.
- Reverting this delivery requires moving the formal branch back through an
  explicit reviewed operation. It does not require changing the running binary.

## Deferred Risks

These quality-level risks were explicitly deferred and do not falsify the
approved outcome:

- Concurrent builds still share output and cache locations without a global
  build lock.
- The candidate executable and sidecar are not published as one filesystem
  transaction; failed publication can leave an incomplete pair.
- A cooperating external process could replace the direct compiler executable
  between verification and use.

They require separate product authorization before they expand implementation
scope or trigger another review cycle.

## Finalization

After this record is committed:

1. Verify that `native-responses-v2` is an ancestor of the record commit.
2. Fast-forward `native-responses-v2` with a compare-and-swap ref update.
3. Switch the worktree to `native-responses-v2` and verify it is clean.
4. Recompute the approved candidate SHA-256 and compare its sidecar identity.
5. Do not replace a running installed binary.
