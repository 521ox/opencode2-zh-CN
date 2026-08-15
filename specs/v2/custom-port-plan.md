# Official V2 Custom Port Plan

Status: active
Date: 2026-08-14
Upstream baseline: `b0480a6f9350d1846cca12a4fd282bdf2286e603`
Custom branch: `native-responses-v2`

## Objective

Move the supported custom product onto the official OpenCode V2 runtime without
recreating the historical mixed V1/V2 execution stack. Preserve existing user
data through an isolated migration boundary and port only behavior that is not
already provided upstream.

## Fixed Boundaries

- `packages/core`, `packages/ai`, `packages/server`, `packages/protocol`,
  `packages/schema`, `packages/client`, `packages/cli`, and `packages/tui` are
  the V2 product owners.
- `packages/opencode` is not a destination for new work.
- No Legacy session writer, Legacy execution loop, dual-write bridge, or runtime
  fallback may be introduced.
- Historical V1 code is retained only inside the official migration or
  read-only decoding boundary.
- Development and test commands must not use the production database.
- Migration testing is copy-only until every database gate in this document is
  satisfied.

## Product Decisions

1. `sdk: "opencode-openai"` remains the explicit signal for the native full
   OpenAI Responses contract when a V1-style configuration is normalized.
2. Legacy `npm` metadata is not required for the native contract. If both
   `sdk: "opencode-openai"` and `npm: "@ai-sdk/openai"` are present, the SDK
   selector wins and the provider resolves to the native V2 package.
3. AI SDK and OpenAI-compatible packages remain compatibility routes. They are
   not silently promoted by provider name, URL, or npm package.
4. The default request is stateless. Stored continuation and remote compaction
   are enabled only by explicit user policy and verified provider capability.
5. `remoteStateBindingID` is not ported. A session must not become permanently
   unusable merely because the user changes to another provider that supports
   the same full Responses capability.
6. Remote state rejection is capability-based and policy-based, not bound to a
   permanent supplier identity. Unsupported remote state must fail clearly or
   rebuild from portable local history according to the operation contract.
7. Native OpenAI Responses models use provider-hosted `web_search` when the
   agent grants wildcard `websearch` permission. The same request must not also
   advertise the local `websearch` function tool. `ask` and `deny` suppress the
   hosted declaration because provider-executed calls cannot pause at the local
   query permission boundary.
8. `subagent.sessionID` continuation is restricted to a same-agent direct child
   of the calling Session. Missing, foreign, and cross-agent children are
   rejected. A running child accepts additional durable prompt input without
   spawning a duplicate child.
9. Nested subagents remain an explicit opt-in. The default depth is one, and a
   deeper configuration does not override the selected agent's `subagent`
   permission rules.
10. V2 TUI localization uses English source dictionaries plus Simplified
    Chinese overrides. The custom build defaults to `zh`, supports `en`, and
    falls back to English for any missing localized key.

## Upstream-Equivalent Work

The following historical custom implementations are already present in a more
mature V2 form and must not be copied:

| Historical capability                                      | Official V2 owner                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| Typed OpenAI Responses HTTP protocol                       | `packages/ai/src/protocols/open-responses.ts` and `openai-responses.ts` |
| Responses WebSocket transport                              | `packages/ai/src/protocols/openai-responses.ts` and route transports    |
| Stateless reasoning replay and `store: false` defaults     | `packages/ai/src/providers/openai-options.ts`                           |
| Hosted Responses result decoding/replay and encrypted reasoning | `packages/ai/src/protocols/openai-responses.ts`                    |
| Stable session prompt cache key                            | `packages/core/src/session/prompt-cache-key.ts`                         |
| Cache read/write usage mapping                             | `packages/ai/src/protocols/*`                                           |
| Shared usage and cost calculation                          | `packages/core/src/session/usage.ts`                                    |
| Usage projection and revert subtraction                    | `packages/core/src/session/projector.ts`                                |
| Cache breakpoint policy                                    | `packages/ai/src/cache-policy.ts`                                       |
| Session history pagination                                 | `packages/core/src/session.ts` and `session/history.ts`                 |
| V2 revert, delete, and execution claim                     | `packages/core/src/session/*`                                           |
| MCP, plugin tools, base subagent execution, shell, and manual compaction | Official V2 Core and CLI/TUI implementations                 |

## Port Matrix

| Item                                                     | Decision                                                      | Owner                                                            | Status                       |
| -------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------- |
| Windows x64 custom build wrapper                         | Port                                                          | `script/build-custom-windows.ps1`                                | Implemented and smoke-tested |
| V2 customization contract                                | Port                                                          | `CUSTOMIZATIONS.md`                                              | Implemented                  |
| V1 `sdk` selector to native V2 OpenAI provider           | Port                                                          | `packages/core/src/v1/config/*`                                  | Implemented and tested       |
| Preserve old custom `part.seq` during V1-to-V2 migration | Port                                                          | `packages/core/src/database/v1-migration.bun.ts`                 | Implemented and tested       |
| Preserve valid staged revert state during migration      | Port                                                          | Same migration owner                                             | Implemented and tested       |
| Make old event cleanup resumable and bounded             | Port                                                          | Same migration owner                                             | Implemented and tested       |
| Managed `previous_response_id` continuation              | Port only for explicit stored policy                          | `packages/ai` wire option plus `packages/core/src/session` owner | Pending                      |
| Canonical provider-input ledger                          | Port only as required by managed continuation                 | Core Session events and SQL                                      | Pending                      |
| Remote Responses compaction                              | Port for explicit native stateless capability, without supplier binding | AI protocol plus Core Session compaction                  | Implemented and tested       |
| Native hosted web-search request declaration             | Port request lowering and route-aware single-owner selection  | `packages/ai` plus `packages/core/src/session/model-request.ts`  | Implemented and tested       |
| Same-agent direct-child subagent continuation            | Port the proven continuation contract onto V2 Session and Job | `packages/core/src/tool/plugin/subagent.ts`                      | Implemented and tested       |
| V2 TUI English/Simplified Chinese dictionaries           | Reimplement against V2 components                             | `packages/tui`                                                   | Implemented and tested       |

## Explicit Drop List

- Historical `packages/openai` standalone SDK.
- Historical `packages/llm` package.
- `packages/opencode/src/session/llm` and all Legacy execution-loop code.
- Legacy prompt-cache-key transformation blocks.
- Duplicate historical cost calculation helpers.
- V1-specific provider-input producer mappings.
- The old execution-generation fence. Official V2 is the only writer.
- Legacy tool-output prune implementation.
- The twelve custom August 2026 database migrations as executable V2
  migrations. Their resulting source data may be read by the migration adapter,
  but the migrations themselves must not be replayed.
- `remoteStateBindingID` and permanent provider identity locking.
- The historical custom subagent center.

## Database Migration Gates

Official V2 must not be started against the production database until these
gates pass on an offline copy.

### Required Source Fixes

Implemented:

1. Nullable legacy `part.seq` is detected dynamically. Databases without the
   custom column retain the official legacy ID fallback. Databases with the
   column preserve SQLite's historical `NULL`, sequence, then ID ordering.
2. Supported persisted revert state is decoded with the official schema and is
   preserved only when its boundary message survives migration. Invalid or
   missing boundaries produce explicit migration warnings.
3. Historical event cleanup commits in bounded batches and persists a
   `clearing-events` progress state in the same transaction as each batch. A
   stopped migration resumes from committed work.

### Copy-Only Rehearsal

1. Stop all processes that use the source database.
2. Copy the database and any WAL/SHM files into a dedicated rehearsal directory
   and verify source/copy SHA-256 evidence.
3. Checkpoint only the copy and require `busy = 0`.
4. Point the V2 binary at the copy through `OPENCODE_DB` and use isolated
   HOME/XDG paths.
5. Require SQLite integrity success and a completed V1-to-V2 migration marker.
6. Compare session counts, message order, per-message part order, usage/cost,
   archive state, compaction state, and supported revert state.
7. Record that legacy event rows are intentionally retired by the official V2
   migration. Do not claim rollback compatibility with the old binary after
   activating the migrated database.

The rehearsal tooling is implemented in
`script/rehearse-v1-to-v2-database.ps1` and
`script/v1-to-v2-migration-sqlite.ts`. It protects the source files against
writes for the duration of the run, starts the candidate binary with isolated
HOME/XDG paths and the D-drive working copy in `OPENCODE_DB`, polls the official
migration status endpoint, and compares every resulting session projection
against the production `transformSession()` implementation.

Migration activation is a separate, explicit user decision after this
rehearsal. The tested rollback before activation is the untouched original
database plus the historical binary.

## Delivery Sequence

### Phase 0: Official Baseline

Completed:

- Installed the pinned official V2 worktree with Bun `1.3.14`.
- Passed AI, Core, CLI, and TUI typechecks.
- Built a Windows x64 single-file binary.
- Passed isolated `--version`, `--help`, and compiled service lifecycle smoke
  checks without using the production database.

### Phase 1: Existing Configuration Compatibility

Completed:

- Added the V1 `sdk` field to the compatibility schema.
- Migrated `sdk: "opencode-openai"` to
  `@opencode-ai/ai/providers/openai`.
- Kept explicit AI SDK providers on the AI SDK route.
- Added a focused configuration migration test and passed Core typecheck.

### Phase 2: Database Migration Safety

Completed:

- Preserved `part.seq` ordering while retaining compatibility with databases
  that do not have the custom column.
- Preserved supported revert and compaction metadata and added explicit warning
  paths for invalid state.
- Made event retirement resumable and bounded.
- Added deterministic no-column, nullable-sequence, revert, and interrupted
  event-cleanup fixtures.
- Added a strict compatibility mapping for the historical custom
  `InterruptedError` recovery marker. Only the known empty, zero-usage,
  identity-matching marker maps to a V2 `aborted` assistant; non-exact markers
  remain fail-closed.
- Passed the complete focused migration suite (`30` tests) and Core typecheck.
- Completed a copy-only rehearsal with candidate SHA-256
  `0D7C8C9421C1E90013FB23DB93E51FA96F49F0791549509EBE63C3DF185D5761`.
- Compared `1732` sessions with zero warnings, mismatches, missing sessions,
  extra sessions, or foreign-key violations. SQLite quick and integrity checks
  returned `ok`, and the migration state reached `completed`.

The successful database at
`D:\opencode2-migration-rehearsal\v1-to-v2-20260815-002821\work\opencode.db`
is a verified rehearsal snapshot, not the production activation source. Once
OpenCode has been reopened, activation requires another fresh stopped-process
migration from the latest V1 database so no post-rehearsal messages are lost.

### Phase 3: Native Provider Canary

- Build with the full embedded Web UI.
- Run an isolated stateless native Responses canary using process-only config
  and a temporary database.
- Confirm the user does not need to add or retain the legacy npm selector.
- Keep provider content and credentials out of artifacts.

### Phase 4: Explicit Stored Continuation

- Add `previous_response_id` wire support and one Core state owner.
- Keep `store: false` as the default.
- Verify bootstrap, active continuation, expiry, revert, compaction, ambiguous
  dispatch, and restart behavior entirely offline before a supplier canary.
- Do not add supplier identity locking.

### Phase 5: Remote Compaction

Completed:

- Added the Responses `context_management.compact_threshold` wire contract for
  automatic compaction on the native OpenAI Responses route.
- Added durable provider checkpoint events and one V2 Session projection owner.
  Reset items replace older checkpoint output; subsequent items retain provider
  order.
- Replays validated opaque checkpoint output exactly for stateless requests and
  preserves complete hosted-tool items for inline continuation.
- Fails an interrupted provider compaction boundary instead of completing an
  empty or non-replayable checkpoint.
- Enforces OpenAI's `16,384` Responses input-item limit during local request
  lowering. Oversized portable histories surface as a typed context overflow,
  allowing the existing V2 runner to perform one local summary recovery before
  retrying with remote automatic compaction still enabled.
- Kept `previous_response_id`, stored continuation, supplier binding, Legacy
  fallback, and dual writes outside this phase.

### Phase 6: Localization And Release

Completed:

- Reimplemented V2 TUI localization in bounded component slices with English
  source dictionaries, complete Simplified Chinese overrides, named
  interpolation, and explicit locale ownership for pure render helpers.
- Localized the main TUI, Mini frontend, dialogs, session views, feature
  plugins, shared UI, generated form validation, startup errors, and session
  epilogue. Non-interactive `opencode run` tool chrome uses the same resolved
  locale. Commands, paths, provider/model identifiers, protocol values, JSON
  events, raw tool output, model content, and external errors remain verbatim.
- Retained official App/UI/Desktop/docs Chinese resources.
- Passed TUI typecheck, dictionary completeness checks, all focused
  localization suites, and `730` integrated tests. The only integrated-suite
  failure was the unchanged timing-sensitive spring retarget test, reproduced
  independently once in ten runs; no animation behavior was modified.
- Rehearsed the V1-to-V2 database migration on a copy and passed the gates for
  `1732` sessions with zero warnings or projection mismatches.
- Built the full WebUI-enabled Windows x64 release artifact and passed the
  isolated compiled-service lifecycle smoke test. The package output,
  worktree export, and timestamped candidate were verified as identical at
  `206949376` bytes with SHA-256
  `704E0CC6CBC09169D35C59676F094B31468D68F69372A735FD4534578CC8B4A0`.
  The timestamped candidate is
  `D:\opencode2-zh-CN-nightly-windows-x64\opencode2-zh-CN-1.18.4-windows-x64-20260815-063640.exe`.

Remaining release actions:

- Replace the installed binary only after explicit user authorization.

## Baseline Test Record

These failures existed before custom runtime changes and are comparison data,
not accepted product behavior:

- AI: `486` passed, `28` skipped, `9` failed. Failures are in upstream Azure
  URL, OpenRouter fixture/shape, and Bedrock Mantle cases.
- CLI: `178` passed, `13` failed. All failures use Unix `mktemp` directly on
  Windows.
- Core: `1746` passed, `25` skipped, `7` failed. Failures are Windows watcher,
  temp-directory cleanup, user-home discovery, and shell quoting cases.
- TUI: `715` passed, `6` skipped, `0` failed.

Each custom slice must pass its focused tests and typecheck and must not expand
the known baseline failure set.
