# OpenCode V2 Customization Contract

## Purpose

This worktree is the V2 successor to the historical `opencode-v1.18.9-custom`
fork. It ports only product-specific value onto the official OpenCode V2
architecture. It must not recreate the former mixed V1/V2 runtime.

For upstream synchronization, `specs/v2/upstream-sync-preservation.md` is the
operational preservation manifest. Every upstream merge or rebase must account
for each stable customization ID in that document before the result can be
accepted.

## Upstream Baseline

- Upstream repository: `anomalyco/opencode`
- Upstream line: official V2 beta
- Pinned source commit: `b0480a6f9350d1846cca12a4fd282bdf2286e603`
- Custom branch: `native-responses-v2`
- Historical custom source: `D:\src\opencode-v1.18.9-custom`
- Historical source policy: frozen reference only; do not develop new product
  behavior there.

## Product Contract

1. V2 packages are the only owners of new runtime behavior. Follow the
   repository dependency direction and package-specific `AGENTS.md` files.
2. Do not add a Legacy session writer, Legacy execution loop, compatibility
   execution fallback, or dual-write path.
3. Historical V1 support is restricted to the official, isolated migration or
   read-only decoder boundary required to preserve existing user data.
4. A session that has entered the V2 runtime must never fall back to a Legacy
   writer after an error.
5. Native full OpenAI Responses behavior is the preferred product contract.
   OpenAI-compatible or AI SDK routes are compatibility routes and must not be
   presented as equivalent to the full native contract.
6. The `mycodex` provider should use the native V2 OpenAI Responses route. The
   finished product must not require users to add a legacy
   `"npm": "@ai-sdk/openai"` selector merely to obtain the full route.
7. Default provider storage remains stateless unless explicitly enabled. Cache,
   continuation, and remote compaction policy must have one V2 owner.
8. Production databases are never used for development migration experiments.
   Database validation uses an offline copy and records rollback evidence.
9. Startup migrations must be metadata-bounded unless an explicitly approved,
   copy-only rehearsal proves that data work is necessary and safe.
10. Native OpenAI Responses requests expose provider-hosted `web_search` by
    default when the selected agent grants wildcard `websearch` permission.
    The local `websearch` function tool is hidden on that route so a request has
    only one search execution owner. `ask` and `deny` do not pre-authorize a
    provider-executed search.
11. The V2 `subagent` tool may continue an existing Session only when the
    supplied `sessionID` identifies a direct child of the caller and the child
    uses the requested agent. Cross-parent and cross-agent reuse are rejected.
    Foreground completion exposes the Core-owned child Session ID in both
    structured metadata and model-visible content so a later call can continue
    the same child even when a tool adapter does not surface metadata.
    Nested delegation remains disabled by default and requires both an explicit
    depth increase and agent permission.
12. When `compaction.prune` is enabled, the upstream request projection bounds
    completed local tool results in immutable chronological blocks of 32. The
    active block shares a budget equal to 10% of model prompt capacity, clamped
    to 10,000-64,000 estimated tokens; completed blocks retain bounded 64-token
    head/tail previews and recovery locations. Appending within one block must
    not change an already-sent prompt prefix. Crossing a block boundary may
    archive the previous block once, batching cache invalidation instead of
    moving a boundary on every result. The durable Session history, exports,
    TUI transcript, managed full-output files, provider-executed results, media
    attachments, and opaque remote compaction checkpoints remain unchanged.
13. Every normal Agent request receives protected Session rules location context
    after the `session.context` hook. The directory is derived only from the
    immutable root Session `start_directory` and readable root Session ID, and
    all descendant subagents share it. Missing or unsafe lineage fails closed;
    Core never guesses from the current directory and never accesses the rules
    directory while resolving context. Persisted Windows and POSIX paths survive
    cross-host migration. Forks without an explicit creation Location remain
    unavailable instead of copying the source Session's start directory.
    Auxiliary title, compaction, and generate requests remain unchanged. See
    `specs/session-rules-context.md`.
14. User-requested native remote compaction uses the normal Responses stream
    with a final `{ "type": "compaction_trigger" }` input item. It never calls
    or falls back to the legacy `/responses/compact` endpoint. Automatic remote
    compaction remains the separate normal-request
    `context_management.compaction.compact_threshold` contract.
15. TUI dialog and composer header close controls use the shared `×` icon with
    the original three-cell mouse target instead of a clickable `esc` label.
    Mouse clicks preserve each caller's existing close callback, and keyboard
    Escape behavior remains unchanged. Textual `esc` hints remain only where
    they mean back, cancel, dismiss, or a keyboard-only action rather than a
    window close control.

## Porting Rules

- Classify every historical customization as `upstream-equivalent`, `port`, or
  `drop` before copying code.
- Prefer the official V2 implementation when it provides equivalent behavior.
- Port behavior and tests, not old file structure.
- Do not copy `packages/opencode` runtime code into V2 packages.
- Do not copy temporary Phase 1-5 adapters when their durable owner already
  exists upstream.
- Keep provider credentials, URLs, prompt contents, response IDs, session IDs,
  and real database data out of committed fixtures and measurement artifacts.

## Localization

- Official V2 already contains Simplified Chinese resources for App, UI,
  Desktop, and documentation. Those resources are the baseline and should not
  be replaced by the old fork wholesale.
- V2 TUI localization is owned by package-local English and Simplified Chinese
  dictionaries. English is the source of truth and fallback; this custom build
  defaults to Simplified Chinese and permits an explicit English locale.
- The TUI, Mini frontend, dialogs, session views, feature plugins, shared UI,
  generated form validation, startup errors, and session epilogue use the same
  locale owner. Dynamic values are interpolated by named parameters; provider
  names, commands, paths, protocol values, model content, and external error
  text remain unchanged.
- Non-interactive `opencode run` tool chrome resolves the same TUI locale; JSON
  events and raw tool output remain unchanged.
- Historical V1 TUI strings are terminology and coverage references, not source
  files to copy, because the V2 component structure changed.
- V1 runtime messages and the historical custom subagent center are not ported.

## Windows Build

Run from the repository root:

```powershell
pwsh -File .\script\build-custom-windows.ps1
```

Useful switches:

- `-SkipInstall`: reuse the current lockfile installation.
- `-SkipWebUI`: diagnostic build without embedded App assets; not for release.
- `-Baseline`: build the non-AVX2 Windows x64 target.
- `-RunServiceSmoke`: run the official isolated compiled-service lifecycle
  smoke test after building. The smoke writes an isolated service config with a
  free loopback port so it can run while another OpenCode channel is active.

The wrapper preserves the official internal binary name `opencode2`, writes a
root worktree copy at `opencode2.exe`, and publishes timestamped artifacts to a
V2-specific directory. It verifies the Bun version, binary version, and SHA-256
identity of all exported copies.

## Safety And Rollback

- The historical binary and source remain available until the V2 port passes
  isolated data migration, provider, CLI, TUI, and service gates.
- Do not replace the installed binary as part of a build or test command.
- Do not point a development V2 binary at the production database.
- Release activation is a separate user-authorized operation.
- Run `script/rehearse-v1-to-v2-database.ps1` only after every OpenCode
  process has exited. The script holds read-only source guards, keeps an exact
  raw copy, migrates a separate working copy, and verifies every migrated
  session with the production `transformSession()` implementation.
- A rehearsal succeeds only when `COMPLETE` exists in its timestamped
  directory and `status.json` reports `outcome: passed`. Migration warnings
  fail by default and require explicit review before
  `-AllowMigrationWarnings` may be used.

## Baseline Evidence

On August 14, 2026, before custom runtime changes:

- Bun `1.3.14` dependency installation completed.
- `packages/ai`, `packages/core`, `packages/cli`, and `packages/tui` typechecks
  passed.
- A Windows x64 single-file `opencode2.exe` built successfully and passed
  isolated `--version` and `--help` smoke checks without creating a database.
- TUI tests passed (`715` passed, `6` skipped).
- Upstream baseline test failures were recorded separately and must not be
  attributed to later custom changes unless their count or behavior changes.

Current TUI localization verification:

- Package typecheck passed.
- English and Simplified Chinese dictionaries passed complete key,
  placeholder, and domain-ownership checks.
- Localization-focused helper, Mini, dialog, session, feature, and component
  suites passed.
- The integrated suite passed `730` tests and skipped `6`; the only observed
  failure was the unchanged timing-sensitive spring retarget test. Isolated
  repetition reproduced the existing nondeterminism once in ten runs, so no
  animation behavior or assertion was changed to mask it.

## Release Candidate Evidence

The full WebUI-enabled Windows x64 release build completed successfully and
passed the isolated compiled-service lifecycle smoke test. The build wrapper
verified that the package output, worktree export, and timestamped candidate
have identical lengths and SHA-256 hashes.

- Version: `1.18.4`
- Bun: `1.3.14`
- Candidate:
  `D:\opencode2-zh-CN-nightly-windows-x64\opencode2-zh-CN-1.18.4-windows-x64-20260815-063640.exe`
- Length: `206949376` bytes
- SHA-256:
  `704E0CC6CBC09169D35C59676F094B31468D68F69372A735FD4534578CC8B4A0`
- Embedded WebUI: `true`
- Baseline target: `false`
- Service smoke: `passed`

This candidate has not replaced the installed or currently running binary.
Release activation remains a separate user-authorized operation.

## V1 Database Rehearsal Evidence

The copy-only V1-to-V2 rehearsal passed against a production database snapshot.
The machine-local artifact timestamp is
`2026-08-15T00:35:09.7130249+08:00`; this is an artifact identifier rather than
the project plan date.

- Migration rehearsal candidate:
  `D:\opencode2-zh-CN-nightly-windows-x64\opencode2-zh-CN-1.18.4-windows-x64-20260815-002523.exe`
- Candidate SHA-256:
  `0D7C8C9421C1E90013FB23DB93E51FA96F49F0791549509EBE63C3DF185D5761`
- Rehearsal:
  `D:\opencode2-migration-rehearsal\v1-to-v2-20260815-002821`
- Sessions compared: `1732`
- Migration warnings, projection mismatches, missing sessions, extra sessions,
  and foreign-key violations: `0`
- SQLite quick check and integrity check: `ok`
- Migration state: `completed`

The successful working database is a verified rehearsal snapshot. It must not
be copied over the active database after OpenCode has been reopened, because
the active V1 database may contain newer messages. Production activation still
requires a fresh stopped-process migration from the latest source database.

See `specs/v2/custom-port-plan.md` for the port matrix and release gates once
the protocol and database inventories are finalized.

## Upstream Synchronization

- Product preservation contract:
  `specs/v2/upstream-sync-preservation.md`
- Executable synchronization procedure:
  `specs/v2/upstream-sync-runbook.md`
- Completed synchronization records:
  `specs/v2/upstream-sync-records/`
