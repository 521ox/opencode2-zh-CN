# Upstream V2 Synchronization Runbook

- Status: active local operating procedure
- Product scope: Core, AI protocol owners selected by the sync, TUI, CLI,
  Plugin, Client, Protocol, and Server dependencies required by those surfaces
- Primary preservation contract: `specs/v2/upstream-sync-preservation.md`

## Purpose

This runbook turns an official V2 update into a bounded, reviewable integration.
It exists to prevent future agents from rediscovering repository ownership,
guessing which upstream commits are safe, or treating a clean textual merge as
evidence that local product behavior survived.

The preservation manifest owns product behavior. This runbook owns execution.
When they conflict, stop and resolve the product contract before changing code.

## Fixed Product Boundary

- Keep every active `CUST-*` contract in the preservation manifest.
- This custom distribution is TUI-first. App, Desktop, and Session UI changes
  are excluded unless a selected Core, Protocol, Client, or build contract
  requires a shared generated consumer.
- Do not restore V1 runtime writers, execution loops, fallback, or dual writes.
- Do not combine an upstream sync with provider-specific experiments, production
  database migration, or installed-binary replacement.
- Treat new user-visible TUI features as product decisions. Do not pull them in
  as dependencies of unrelated bug fixes.

## Phase 1: Frame The Sync

Record these immutable refs before fetching or integrating:

```text
old_upstream=
old_custom=
new_upstream=
merge_base=
worktree_clean_before=
```

Confirm the official ref through both Git and GitHub:

```powershell
git ls-remote origin refs/heads/v2
gh api repos/anomalyco/opencode/branches/v2 --jq '.commit.sha'
```

Fetch without merging:

```powershell
git fetch origin v2
```

Reject the run if the official branch was rewritten or the recorded merge base
is not an ancestor of both sides.

## Phase 2: Generate The Evidence Set

Generate complete path reports for:

1. old upstream to old custom;
2. old upstream to new upstream;
3. new upstream to new custom after integration.

Every path must map to at least one stable customization ID or to an explicit
non-functional bucket. Unclassified paths reject the sync.

Use commit and path evidence together:

```powershell
git log --reverse --oneline <old-upstream>..<new-upstream>
git diff --name-status <old-upstream> <new-upstream>
git diff --name-status <old-upstream> <old-custom>
git merge-tree --write-tree --messages <old-custom> <new-upstream>
```

`git merge-tree` is only a textual-conflict signal. Review every overlapping
owner even when Git reports a clean merge.

## Phase 3: Classify Official Commits

Assign every material commit to one category:

- `DIRECT`: selected behavior lands on unmodified local owners.
- `REBASE_DELTA`: take the official owner, then reapply the named local semantic
  delta.
- `CONFLICT_INTEGRATE`: both sides materially changed the same contract; merge
  the final upstream state manually.
- `SKIP`: outside the product boundary or intentionally deferred.

Keep dependency clusters intact. Typical examples include a protocol route
change plus generated OpenAPI/client artifacts, or a schema change plus its
configuration and promise-adapter consumers.

Do not cherry-pick formatting-only generation commits independently. Integrate
the owning schema/protocol change, then run the local generator.

## Phase 4: Create An Isolated Integration Branch

Never synchronize directly on the active custom branch:

```powershell
git switch -c integrate/v2-<official-short-sha>-<scope>
```

Keep upstream commits attributable where practical. Stop at the first blocking
batch failure.

## Phase 5: Integrate In Batches

Use the smallest dependency-complete batches. A proven order is:

1. low-risk independent runtime fixes;
2. protocol/config/plugin groups and generated consumers;
3. selected TUI bug fixes;
4. high-risk transport or prompt architecture only in a separately authorized
   cycle.

After each batch:

- run focused tests for the changed owner;
- run affected package typechecks;
- inspect `git status`, `git diff --check`, and generated output;
- stop before the next batch if evidence is incomplete.

## Phase 6: Resolve TUI Changes

For every TUI commit:

- preserve the English source and Simplified Chinese dictionary parity;
- translate new product copy instead of accepting hardcoded upstream English;
- preserve main and Mini compaction status, notice, and no-divider behavior;
- protect fixed tab, toolbar, footer, and prompt dimensions;
- separate bug fixes from optional feature additions.

An upstream patch may depend on a feature that was intentionally skipped. If a
patch only modifies the skipped feature's code, skip the dependent patch rather
than importing the feature through conflict resolution.

## Phase 7: Regenerate Contracts

There is no root `bun run generate` script. Use package owners:

```powershell
cd packages/protocol
bun run generate
bun run check:generated

cd ../client
bun run generate
bun run check:generated

cd ../www
bun script/generate-openapi.ts
bun script/generate-openapi.ts --check
```

After a cherry-pick adds workspace dependencies, run:

```powershell
bun install --frozen-lockfile
```

This refreshes workspace links without changing the lockfile.

Generated OpenAPI may show a large line diff because definition order changed.
Before accepting it, parse the old and new JSON and compare path and schema keys.
Reject unexplained path changes. Record the semantic added, removed, and changed
schema counts.

On Windows, a generator can leave content-identical files marked modified due
to line-ending/stat changes. Compare index and worktree object IDs before using
`git add` to normalize the state. Never commit a stat-only change.

## Phase 8: Run Verification

Use the preservation manifest's minimum matrix and add owner-specific tests.
At minimum:

- typecheck every changed package;
- run focused Core Session, compaction, context, transport, and configuration
  tests when shared request owners changed;
- run TUI i18n, Session Tabs, interrupt, footer, main compaction, and Mini
  compaction tests when TUI owners changed;
- run generated-contract checks after schema or protocol work;
- run `git diff --check` and `git fsck --no-dangling --no-progress`.

### Windows Test Isolation

Core configuration tests use upward directory discovery. The default Windows
temporary directory can be below the real user home, causing actual `.claude`
or `.opencode` directories to enter test results. Run discovery-sensitive tests
with `TEMP` and `TMP` pointing to a temporary root outside the user home:

```powershell
$tmp = "D:\src\.tmp\core-tests"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:TEMP = $tmp
$env:TMP = $tmp
bun test <files>
```

Do not change product discovery logic or expected results to hide host-directory
contamination.

## Phase 9: Handle Cherry-Pick Sequencers Safely

`git cherry-pick --skip` continues the remaining sequencer automatically. Do
not immediately start a second cherry-pick with the same remaining commits.

If a duplicate sequence starts:

1. inspect `CHERRY_PICK_HEAD`;
2. inspect `git rev-parse --git-path sequencer/head` and `sequencer/todo`;
3. verify the sequencer head equals the already completed integration HEAD;
4. use `git cherry-pick --abort` only after that verification.

This preserves already completed commits while removing the duplicate sequence.

## Phase 10: Build And Review

Build an isolated Windows candidate without replacing the active binary:

```powershell
pwsh -File .\script\build-custom-windows.ps1 -RunServiceSmoke
```

Require:

- embedded WebUI unless the build is explicitly diagnostic;
- package/Bun version agreement;
- compiled-service election, authentication, plugin discovery, stop, and cleanup
  smoke;
- identical artifact length and SHA-256 across exports.

Run one independent read-only review against the fixed batch boundary. An
`APPROVE WITH DEFERRED RISKS` verdict is approval when no blocking product or
contract finding remains. Deferred traceability work must be recorded but must
not silently expand the fixed integration scope.

## Phase 11: Merge And Record

Merge only after all fixed gates pass:

```powershell
git switch <custom-branch>
git merge --ff-only <integration-branch>
```

Record:

- all fixed refs and the final custom HEAD;
- selected and skipped commit groups;
- test/typecheck/generator evidence;
- review verdict;
- candidate path, length, and SHA-256;
- known baseline failures and why they do not falsify completion;
- the new-upstream-to-new-custom path report and closure result.

Do not replace the installed binary or activate database migrations as part of
the merge.

## Recovery

- Abort the current cherry-pick when the conflict requires an unauthorized
  product change.
- Stop the batch after a blocking test or typecheck failure.
- Delete the isolated integration branch to return to the recorded custom HEAD.
- Revert generated and documentation commits independently from runtime commits.
- Keep the previous installed binary until the user explicitly authorizes
  replacement.

## Known Baseline Test Pattern

`packages/tui/test/feature-plugins/home-footer.test.ts` imports the Home Footer
module directly. The module already imports plugin context, which imports the
builtins list and references Home Footer before direct-module initialization is
complete. This test-only import direction can produce a temporal-dead-zone
error even though the production TUI starts from the builtins list. Verify a
candidate did not introduce the cycle by comparing the pre-integration import
graph and changed lines; do not use the baseline failure to hide a new import.
