# V2 Upstream Sync Preservation Manifest

Status: active

Last audited: 2026-08-15

## Purpose

This document prevents intentional custom product behavior from disappearing
during an upstream OpenCode V2 merge, rebase, or clean re-port. It is the
operational companion to `CUSTOMIZATIONS.md`, which remains the product-level
contract.

A clean Git merge is not acceptance evidence. An upstream synchronization is
complete only when every stable customization ID below is classified and its
acceptance evidence is recorded.

## Authority And Scope

- `CUSTOMIZATIONS.md` owns the high-level product contract.
- This document owns the preservation inventory and upstream sync checklist.
- Feature-specific accepted specifications remain authoritative for detailed
  behavior, including `specs/session-rules-context.md`.
- Official V2 implementations replace historical V1 implementations whenever
  they provide equivalent behavior.
- Local code is preserved only for product behavior that official V2 does not
  provide or does not provide with the required semantics.
- The historical V1 worktree is a read-only evidence source, not a runtime or
  merge destination.

## Audit Snapshot

The initial inventory is based on:

- Original official V2 base: `b0480a6f9350d1846cca12a4fd282bdf2286e603`
- First custom port commit: `42c0c9b9600bab5e0b4ac4e9433342c5be3b5ff0`
- Session rules context commit: `24307f8eeca80ac7e476a90bceebf4ff7d2fae7a`
- Official V2 comparison head on 2026-08-15:
  `d35c6f04edc5778cd720396ccb86e43cf1681b7f`

This snapshot is historical evidence, not a permanent upstream pin. Update the
comparison head and item statuses during every synchronization.

### Changed-path evidence

The initial path reports are stored as machine-readable TSV files:

| Report                                                     | Refs                   | Paths | SHA-256                                                            |
| ---------------------------------------------------------- | ---------------------- | ----: | ------------------------------------------------------------------ |
| `specs/v2/upstream-sync-paths/20260815-local-delta.tsv`    | `b0480a6f9..24307f8ee` |   216 | `886E9EDD6AE83C3C51BA25E7BEB3AACF90DED85211F7864DA12A41C38941A8D7` |
| `specs/v2/upstream-sync-paths/20260815-upstream-delta.tsv` | `b0480a6f9..d35c6f04e` |   678 | `4931840B413A9B6E15C4BBA5D7B03773D8FE7467B0F608AAC5972E0D1D12DE52` |

Every row in the local-delta report maps to one or more stable customization
IDs or an explicit non-functional bucket. The initial report contains zero
unclassified paths. This manifest and the path reports themselves were created
after `24307f8ee`; the next local-delta report must classify them as
`BUCKET-GOVERNANCE`.

### Known overlap at this snapshot

The 2026-08-15 merge-tree comparison reported textual conflicts in:

- `packages/ai/src/protocols/openai-responses.ts`
- `packages/ai/test/provider-package.test.ts`
- `packages/core/src/session/model-request.ts`
- `packages/core/test/session-runner.test.ts`
- `packages/tui/src/component/prompt/index.tsx`

The following files auto-merged in that comparison but still require semantic
review because they participate in route ownership, transport, compaction, or
TUI state:

- `packages/ai/src/protocols/open-responses.ts`
- `packages/ai/src/providers/openai.ts`
- `packages/ai/src/route/client.ts`
- `packages/core/src/session/runner/llm.ts`
- `packages/tui/src/routes/session/index.tsx`

## Classification

Each item uses one of these synchronization decisions:

- `PRESERVE`: official V2 does not provide the required product behavior.
- `REBASE_DELTA`: adopt the current official V2 owner and reapply only the
  documented local semantic delta.
- `UPSTREAM_EQUIVALENT`: remove the local implementation after equivalence is
  demonstrated by tests or wire evidence.
- `OPERATIONS`: local build, migration, or release tooling rather than runtime
  product behavior.
- `DROP`: historical behavior intentionally excluded by the product contract.

The only non-functional buckets accepted by the initial path ledger are:

- `BUCKET-BUILD-OUTPUT`: ignore rules for generated or exported build artifacts.
- `BUCKET-GOVERNANCE`: customization contracts, port plans, manifests, and path
  evidence that do not alter runtime behavior.

Any unclassified path, unknown stable ID, or unknown bucket rejects the sync.

## Preservation Summary

| ID                   | Capability                                                              | Decision              | Introduced by            | Primary owner                                               |
| -------------------- | ----------------------------------------------------------------------- | --------------------- | ------------------------ | ----------------------------------------------------------- |
| `CUST-RESP-001`      | Native OpenAI Responses route ownership and compatibility routing       | `REBASE_DELTA`        | `42c0c9b96`              | `packages/ai`, Core model resolution                        |
| `CUST-RESP-002`      | Extended Open Responses provider options                                | `PRESERVE`            | `42c0c9b96`              | `packages/ai/src/protocols/utils/open-responses-options.ts` |
| `CUST-RESP-003`      | Provider-hosted web search single-owner behavior                        | `REBASE_DELTA`        | `42c0c9b96`              | AI Responses lowering and `SessionModelRequest`             |
| `CUST-RESP-004`      | Provider-hosted image generation factory and replay                     | `UPSTREAM_EQUIVALENT` | `42c0c9b96`              | Native OpenAI provider and Responses protocol               |
| `CUST-COMP-001`      | Native automatic remote compaction checkpoints                          | `PRESERVE`            | `42c0c9b96`              | AI Responses parser and Core Session projection             |
| `CUST-COMP-002`      | Explicit `POST /responses/compact` for user-requested manual compaction | `PRESERVE`            | `42c0c9b96`              | AI OpenAI Responses operation and Core compaction           |
| `CUST-CONTEXT-001`   | Request-time local tool-result pruning                                  | `PRESERVE`            | `42c0c9b96`              | Core message projection                                     |
| `CUST-TRANSPORT-001` | Incomplete-stream failure and Responses input-item limit                | `PRESERVE`            | `42c0c9b96`              | AI route and provider-error handling                        |
| `CUST-SUBAGENT-001`  | Same-agent direct-child Session continuation                            | `PRESERVE`            | `42c0c9b96`              | Core subagent tool                                          |
| `CUST-RULES-001`     | Protected Session rules location context                                | `PRESERVE`            | `24307f8ee`              | Core Session persistence and request preparation            |
| `CUST-TUI-001`       | English/Simplified Chinese TUI localization                             | `PRESERVE`            | `42c0c9b96`              | `packages/tui/src/i18n`                                     |
| `CUST-TUI-002`       | Compaction status and notification UX without transcript dividers       | `PRESERVE`            | `42c0c9b96`              | Main and Mini TUI Session projections                       |
| `CUST-MIGRATION-001` | V1 configuration and built-in database migration compatibility          | `PRESERVE`            | `42c0c9b96`, `24307f8ee` | Core V1 normalization and migration boundary                |
| `CUST-MIGRATION-002` | Copy-only rehearsal, native context repair, and VACUUM safety           | `OPERATIONS`          | `42c0c9b96`              | Migration scripts and handoff documents                     |
| `CUST-OPS-001`       | Windows build, export identity, and compiled-service smoke              | `OPERATIONS`          | `42c0c9b96`              | Build wrapper and CLI service smoke                         |

## `CUST-RESP-001`: Native Route Ownership And Compatibility Routing

### Required behavior

- `@opencode-ai/ai/providers/openai` owns the full native OpenAI Responses
  contract.
- V1 `sdk: "opencode-openai"` normalizes to that native V2 provider package.
- A provider such as `mycodex` can select the native contract without requiring
  users to add `npm: "@ai-sdk/openai"`.
- AI SDK and generic OpenAI-compatible routes remain compatibility routes. A
  provider name, base URL, or mutable route ID must not silently grant native
  capabilities.
- Native capability checks must use trustworthy route ownership or capability
  provenance rather than provider-name equality alone.

### Upstream synchronization rule

Adopt the official unified `openai-responses` HTTP/WebSocket transport and
Session transport manager. Do not retain a second
`openai-responses-websocket` route merely to identify transport. Reapply native
ownership, compatibility routing, remote compaction qualification, and local
provider normalization on top of the official route owner.

Official stored continuation may remain present but disabled. The default
product policy remains stateless unless explicitly enabled and verified.

### Owners

- `packages/ai/src/providers/openai.ts`
- `packages/ai/src/protocols/openai-responses.ts`
- `packages/ai/src/route/client.ts`
- `packages/core/src/model-resolver.ts`
- `packages/core/src/v1/config/provider.ts`
- `packages/core/src/v1/config/migrate.ts`

### Acceptance evidence

- Native package resolution selects the native Responses route.
- An explicit AI SDK package remains on an `ai-sdk:*` route.
- A generic or colliding provider cannot acquire native compaction capability.
- Provider-package, model-resolver, configuration, and V1 migration tests pass.

## `CUST-RESP-002`: Extended Open Responses Options

### Required behavior

The typed public option contract preserves:

- `compactThreshold` as a positive safe integer.
- Service tiers `auto`, `default`, `flex`, `scale`, `priority`, `fast`, and
  `ultrafast`.
- Existing reasoning, include, text verbosity, instructions, and store options.
- Request lowering to
  `context_management: [{ type: "compaction", compact_threshold: ... }]` and
  `service_tier` without requiring an untyped body overlay.

Official V2 currently does not provide the complete local service-tier union or
the local compact-threshold option. Upstream option refactors must not narrow
this public contract silently.

### Owners

- `packages/ai/src/protocols/utils/open-responses-options.ts`
- `packages/ai/src/protocols/open-responses.ts`
- `packages/ai/src/providers/open-responses-options.ts`
- `packages/ai/src/providers/openai-options.ts`

### Acceptance evidence

- Type-level option fixtures accept every local tier, including `fast`.
- Runtime lowering emits the configured `service_tier`.
- Invalid compact thresholds are omitted; valid thresholds lower exactly.
- OpenAI Responses provider-option and request-body tests pass.

## `CUST-RESP-003`: Hosted Web Search Has One Execution Owner

### Required behavior

- Native OpenAI Responses requests advertise provider-hosted `web_search` when
  the selected Agent grants wildcard `websearch` permission.
- The same request does not also advertise the local `websearch` function tool.
- `ask` and `deny` do not pre-authorize a provider-executed search because the
  provider cannot pause at the local permission boundary.
- Compatibility routes keep their existing local-tool behavior.

### Owners

- `packages/ai/src/protocols/openai-responses.ts`
- `packages/core/src/session/model-request.ts`
- `packages/core/src/session/runner/to-llm-message.ts`

### Acceptance evidence

- Native wildcard permission produces one hosted search declaration.
- Native ask/deny produces no hosted search declaration.
- Native requests contain no duplicate local web-search tool.
- Compatibility routes retain their expected local tool definition.

## `CUST-RESP-004`: Hosted Image Generation Factory And Replay

### Required behavior

- The native OpenAI provider exports a typed `imageGeneration()` hosted-tool
  factory for generate and edit requests.
- Supported image-generation options lower into the native Responses tool
  definition without requiring a generic body overlay.
- Invalid or future option values are filtered according to the public provider
  contract rather than producing malformed requests.
- Provider-executed image-generation calls, partial-image events, final output,
  and usage remain replayable through the normal Responses event pipeline.
- Generic compatibility routes do not acquire native tool ownership merely by
  sharing a provider name or base URL.

Official V2 at the comparison head provides the typed factory, generate/edit
options, request lowering, partial/final image events, and provider-executed
replay required by this item. During the next upstream synchronization, remove
the duplicate local implementation after wire and type fixtures demonstrate
equivalence. Preserve this ID as an acceptance row until that deletion is
verified; do not preserve a redundant fork merely because the historical local
commit introduced it first.

### Owners

- `packages/ai/src/providers/openai.ts`
- `packages/ai/src/protocols/openai-responses.ts`
- `packages/ai/src/protocols/open-responses.ts`

### Acceptance evidence

- Provider factory type fixtures cover valid and rejected options.
- Request-body tests cover generate, edit, partial images, quality, size, and
  output compression.
- Recorded provider replay preserves image-generation events and output.
- AI provider-package and OpenAI Responses tests pass.

## `CUST-COMP-001`: Automatic Remote Compaction Checkpoints

### Required behavior

- Native OpenAI Responses may request provider automatic compaction through
  `context_management: [{ type: "compaction", compact_threshold: ... }]`.
- Automatic compaction remains part of the normal Responses request and stream.
  It must not call the explicit `/responses/compact` endpoint.
- Provider compaction start and opaque checkpoint items become durable Session
  events and one projected compaction message.
- A reset checkpoint replaces older remote output; later checkpoint items keep
  provider order.
- Replay sends validated opaque checkpoint items exactly and preserves hosted
  tool calls and their required local results.
- A compaction boundary cannot complete without a replayable checkpoint.
- OpenAI's 16,384 input-item limit surfaces as typed context overflow so Core
  can perform one bounded local recovery rather than sending an invalid request.
- Stored continuation, supplier binding, Legacy fallback, and dual writes are
  not implicit requirements of automatic remote compaction.

### Owners

- `packages/ai/src/protocols/utils/open-responses-options.ts`
- `packages/ai/src/protocols/open-responses.ts`
- `packages/ai/src/protocols/openai-responses.ts`
- `packages/ai/src/protocols/utils/openai-compaction.ts`
- `packages/ai/src/schema/events.ts`
- `packages/core/src/session/model-request.ts`
- `packages/core/src/session/runner/publish-llm-event.ts`
- `packages/core/src/session/message-updater.ts`
- `packages/core/src/session/remote-compaction-replay.ts`
- `packages/core/src/session/history.ts`
- `packages/core/src/session/runner/to-llm-message.ts`
- `packages/schema/src/session-event.ts`
- `packages/schema/src/session-message.ts`

### Acceptance evidence

- Automatic checkpoint projection and replay tests pass.
- Reset and append ordering are deterministic.
- Hosted function-call results remain paired after replay.
- Missing checkpoints fail the boundary rather than producing an empty summary.
- The 16,384-item overflow path reaches bounded recovery.

## `CUST-COMP-002`: Explicit Manual Native Remote Compaction

### Required behavior

- A user-requested native manual compaction may call `POST /responses/compact`.
- Automatic threshold compaction and provider overflow handling must not call
  this endpoint.
- The compact operation preserves configured base URL, query, authorization,
  organization/project headers, provider options, request middleware, and
  Session HTTP hooks.
- The operation sends the supported compact request shape and validates opaque
  compaction output before publishing durable remote items.
- AI SDK and generic compatibility routes continue to use local summary
  compaction.
- Normal Agent protected context, including Session rules location context, is
  not sent to the provider-native compact endpoint.
- `previous_response_id`, stored continuation, and permanent supplier binding
  remain outside this custom operation unless explicitly approved later.

### Owners

- `packages/ai/src/protocols/openai-responses.ts`
- `packages/ai/src/protocols/utils/openai-compaction.ts`
- `packages/ai/src/providers/openai.ts`
- `packages/core/src/session/compaction.ts`
- `packages/core/src/session/model-request.ts`
- `packages/core/src/session/runner/llm.ts`

### Acceptance evidence

- Manual compaction issues `/responses/compact` only for the native owner.
- Automatic native Responses requests carry `compactThreshold` through normal
  provider options and issue zero explicit compact endpoint calls.
- Native automatic overflow surfaces as provider overflow rather than invoking
  the manual endpoint or a local-summary fallback.
- Compatibility routes use local summary compaction.
- Compact HTTP body tests prove protected Session context is absent.
- HTTP/provider failures produce durable failed compaction state.
- AI and Core compaction, runner, and provider-owner tests pass.

## `CUST-CONTEXT-001`: Request-Time Tool-Result Pruning

### Required behavior

- `compaction.prune` controls a deterministic model-request projection only.
- Completed local tool results are divided into immutable chronological blocks
  of 32.
- The active block shares a 10% model-prompt budget clamped to 10,000-64,000
  estimated tokens. Completed blocks retain 64-token head/tail previews and
  recovery locations.
- Appending within one block must not change an already-projected historical
  prefix. A block rollover may archive the preceding block once.
- Oversized text keeps a bounded head and tail with an explicit truncation
  marker.
- Durable Session messages, exports, TUI transcript, managed full-output files,
  provider-executed results, media attachments, and opaque remote compaction
  checkpoints remain unchanged.
- Tool call/result pairing, message order, current-turn correctness, and
  byte-stable repeated projection are mandatory.

### Owners

- `packages/schema/src/config/compaction.ts`
- `packages/core/src/config/normalize.ts`
- `packages/core/src/session/model-request.ts`
- `packages/core/src/session/runner/to-llm-message.ts`
- `packages/core/src/session/history.ts`

### Acceptance evidence

- Disabled mode is byte-equivalent to the unpruned projection.
- Repeated projection of identical state is byte-identical.
- Appending within the active block leaves the complete prior projected prefix
  byte-identical.
- A 32-result rollover produces one bounded archive transition; the next append
  within the new block is prefix-stable again.
- Active-block budget, archived previews, and head/tail markers are covered.
- Remote checkpoints, provider results, media, and durable history are unchanged.
- `packages/core/test/session-runner-message.test.ts` covers the projection and
  token budgets.
- Configuration normalization tests prove `compaction.prune` remains supported
  rather than reverting to an ignored or unsupported field.

## `CUST-TRANSPORT-001`: Incomplete Streams And Responses Item Limit

### Required behavior

- OpenAI provider failures with code `stream_read_error` classify as an
  incomplete stream rather than a successful finish.
- A stream that ends without a recognized terminal provider event fails with a
  typed incomplete-stream provider error.
- `response.completed`, `response.incomplete`, and the handled provider failure
  path remain explicit terminal states; an arbitrary socket close is not one.
- OpenAI Responses input arrays larger than 16,384 items fail locally as typed
  context overflow before an invalid request is dispatched.
- Core recovery may consume typed context overflow, while incomplete streams
  remain visible provider failures and must not publish a successful Step.

Official V2 contains the general provider-error framework but does not currently
provide all of these exact OpenAI-specific failure and prevention semantics.

### Owners

- `packages/ai/src/provider-error.ts`
- `packages/ai/src/schema/errors.ts`
- `packages/ai/src/route/client.ts`
- `packages/ai/src/protocols/openai-responses.ts`
- `packages/core/src/session/runner/llm.ts`
- `packages/core/src/session/runner/publish-llm-event.ts`

### Acceptance evidence

- `packages/ai/test/provider-error.test.ts` covers `stream_read_error`.
- OpenAI Responses tests cover the 16,384-item boundary and missing terminal
  events.
- Core runner tests prove incomplete streams fail the Step instead of settling
  it successfully.
- Error classification remains structured; merge resolution must not preserve
  only an error-text substring while dropping the typed classification.

## `CUST-SUBAGENT-001`: Direct-Child Session Continuation

### Required behavior

- `subagent.sessionID` may continue only a direct child of the calling Session.
- The child must use the requested Agent.
- Missing, foreign-parent, and cross-Agent Sessions are rejected.
- A running child accepts additional durable prompt input rather than spawning
  a duplicate child.
- New prompt input is durably admitted before joining the already-running child
  Job, so the child cannot finish without observing the continuation input.
- Nested delegation remains disabled by default. Increasing depth does not
  override the selected Agent's `subagent` permission.

### Owners

- `packages/core/src/tool/plugin/subagent.ts`
- `packages/core/src/plugin/runtime.ts`

### Acceptance evidence

- New child creation and same-child continuation both pass.
- Foreign-parent, cross-Agent, missing, and nested-denied cases fail.
- Running-child tests prove prompt admission occurs before Job join.
- The returned child Session ID remains reusable by a later call.
- `packages/core/test/tool-subagent.test.ts` passes.

## `CUST-RULES-001`: Protected Session Rules Location Context

### Required behavior

The complete accepted contract is in `specs/session-rules-context.md`. The
preservation-critical points are:

- Every normal Agent request receives the protected context after the
  `session.context` hook.
- Root and descendant Sessions share
  `<root-start-directory>/.opencode/rules/<root-session-id>`.
- The root start directory is an immutable persisted creation fact.
- Resolution performs no filesystem access and never guesses from current
  process, project, worktree, or descendant directories.
- Unsafe or missing lineage fails closed.
- Title, generate, local summary, and native compact auxiliary requests do not
  receive the protected part.
- Forks remain unavailable until their event contract carries an authoritative
  creation Location.

### Owners

- `packages/core/src/session/start-directory.ts`
- `packages/core/src/session/rules-location.ts`
- `packages/core/src/session/sql.ts`
- `packages/core/src/session/store.ts`
- `packages/core/src/session/projector.ts`
- `packages/core/src/session/model-request.ts`
- `packages/core/src/session/compaction.ts`
- `packages/core/src/database/migration/20260815081049_session_start_directory.ts`

### Acceptance evidence

- Root, direct-child, and nested-child lineage tests pass.
- Move, fork, invalid path, control character, missing parent, and cycle cases
  retain their specified behavior.
- Plugin system-context transforms cannot remove the protected part.
- Manual and overflow native compact request bodies omit it.
- Migration generation checks and Core typecheck pass.

## `CUST-TUI-001`: TUI Localization

### Required behavior

- English dictionaries are the source and fallback.
- Simplified Chinese dictionaries have complete key and placeholder parity.
- The custom build defaults to Simplified Chinese and permits explicit English.
- BCP-47 `zh-*` locales normalize to Simplified Chinese; other non-empty locale
  values use the English fallback contract.
- Main TUI, Mini, dialogs, Session views, feature plugins, shared helpers,
  startup errors, form validation, Session epilogue, and non-interactive run
  tool chrome use the same locale owner.
- Commands, paths, model/provider identifiers, protocol values, raw tool output,
  JSON events, model content, and external error text remain unchanged.
- Existing official App/UI/Desktop/documentation localization is not replaced by
  historical V1 resources.

### Owners

- `packages/tui/src/context/i18n.tsx`
- `packages/tui/src/i18n/index.ts`
- `packages/tui/src/config/index.tsx`
- `packages/tui/src/mini/footer.ts`
- `packages/tui/src/mini/runtime.lifecycle.ts`
- `packages/tui/src/i18n/en/**`
- `packages/tui/src/i18n/zh/**`
- `packages/cli/src/run/run.ts`
- `packages/cli/src/commands/handlers/run.ts`

### Acceptance evidence

- `packages/tui/test/i18n.test.ts` covers the default locale, normalization,
  interpolation, key parity, placeholder parity, and domain ownership.
- `packages/tui/test/mini/i18n.test.ts` covers Mini defaults and dictionary
  parity.
- Non-interactive JSON output and raw tool output remain unlocalized.
- TUI and CLI typechecks pass.

## `CUST-TUI-002`: Compaction Status And Notification UX

### Required behavior

- Compaction durable events and messages remain available for replay and context
  reconstruction.
- Main and Mini TUI do not render compaction as ordinary transcript dividers or
  synthetic scrollback commits.
- Running compaction appears in the prompt/footer status surface.
- Completion, cancellation, and failure produce localized transient feedback.
- Manual and automatic compaction use the same durable lifecycle, while their
  reason remains available for diagnostics.

### Owners

- `packages/tui/src/component/prompt/index.tsx`
- `packages/tui/src/routes/session/index.tsx`
- `packages/tui/src/mini/stream-v2.transport.ts`
- `packages/tui/src/mini/scrollback.writer.tsx`
- `packages/tui/src/mini/footer.ts`
- `packages/tui/src/i18n/en/session.ts`
- `packages/tui/src/i18n/zh/session.ts`
- `packages/tui/src/i18n/en/mini.ts`
- `packages/tui/src/i18n/zh/mini.ts`

### Acceptance evidence

- Main and Mini projections emit no compaction transcript divider.
- `packages/tui/test/mini/stream-v2.transport.test.ts` covers replay filtering,
  running footer status, retained completion notice, cancellation, and failure.
- Running, completed, cancelled, and failed states update the intended status or
  notice surface without creating a transcript row.
- Durable compaction projection tests remain unchanged and pass.
- TUI i18n and compaction transport tests pass.

### Known residual

Automatic interruption may still use the durable
`compaction.interrupted` error type where one TUI classifier recognizes only
`aborted`. During an upstream sync, do not treat failure-colored interruption
feedback as the intended contract; preserve or improve cancellation semantics.

## `CUST-MIGRATION-001`: V1 Configuration And Database Compatibility

### Required behavior

- V1 `sdk: "opencode-openai"` selects the native V2 provider package.
- Explicit AI SDK package selection remains explicit and is not silently
  promoted.
- Historical provider headers and body overlays retain supported semantics.
- Custom nullable `part.seq` ordering is preserved when present while official
  databases without that column retain official fallback behavior.
- Supported staged revert and compaction metadata survive when their boundaries
  remain valid.
- Historical event retirement is bounded, transactional, and resumable.
- Historical `time_compacting` state retains its supported meaning.
- Only the exact historical custom interruption marker maps to an aborted V2
  assistant; non-exact records fail closed.
- Session `start_directory` backfill uses only authoritative persisted creation
  facts.

### Owners

- `packages/core/src/v1/config/provider.ts`
- `packages/core/src/v1/config/migrate.ts`
- `packages/core/src/database/v1-migration.bun.ts`
- `packages/core/src/database/migration/20260815081049_session_start_directory.ts`

### Acceptance evidence

- V1 config normalization tests cover native and explicit AI SDK routes.
- Migration fixtures cover missing/present `part.seq`, invalid state, resume,
  interruption markers, and authoritative start-directory facts.
- `packages/core/test/config/config.test.ts`,
  `packages/core/test/v1-migration.test.ts`, and
  `packages/core/test/database-migration.test.ts` pass.

## `CUST-MIGRATION-002`: Rehearsal, Context Repair, And VACUUM Safety

### Required behavior

- V1-to-V2 rehearsal operates only after all source-using OpenCode processes
  stop. It holds read-only source guards, preserves raw and working copies, and
  proves source database and sidecar hashes remain unchanged.
- The candidate binary uses isolated home, database, service configuration,
  loopback port, and authentication while migrating the working copy.
- A rehearsal succeeds only when `status.json` reports `outcome: passed` and the
  timestamped run directory contains `COMPLETE` rather than `FAILED`.
- The native context-repair script converts only safe, provider-compatible V1
  remote checkpoints into completed V2 compaction state.
- The generated compaction is inserted immediately after its assistant anchor;
  message sequence, event watermark, provider-executed tool markers, and local
  tool-result pairing remain consistent in a per-Session immediate transaction.
- Repair IDs are deterministic and a second apply reports `changed: 0`.
- Path safety rejects the active target, backups, WAL/SHM files, and symlink or
  hard-link aliases where those would defeat copy-only or recovery guarantees.
- A production `VACUUM` requires a fresh post-context, pre-VACUUM backup. An
  older backup created before context repair must never be the only recovery
  point because restoring it would undo the repair.
- Historical database counts, hashes, and expected file sizes are dated evidence
  only and must not become future production acceptance thresholds.

### Owners

- `script/rehearse-v1-to-v2-database.ps1`
- `script/v1-to-v2-migration-sqlite.ts`
- `script/migrate-v1-context-to-v2.ts`

### Acceptance evidence

- Rehearsal validates Session projections and reports zero unreviewed warnings,
  missing Sessions, extra Sessions, projection mismatches, and foreign-key
  violations.
- SQLite `quick_check`, `integrity_check`, and `foreign_key_check` pass on the
  appropriate copies.
- The source database, WAL, and SHM evidence remains unchanged.
- Context repair apply followed by a second apply reports no further changes.
- Post-VACUUM dry-run classification proves the context repair remains present.
- Recovery uses only the verified post-context backup and requires explicit
  authorization before replacing the active database.

## `CUST-OPS-001`: Windows Build, Export, And Service Smoke

### Required behavior

- The Windows wrapper builds the official internal binary name `opencode2`.
- Full WebUI embedding is the release default; `-SkipWebUI` is diagnostic only.
- Exported package, worktree, and timestamped candidate copies have identical
  length and SHA-256.
- The compiled service smoke uses isolated config, home, database, and a free
  loopback port so it can run beside another installed channel.
- The smoke proves contender election, authenticated API and OpenAPI access,
  query-token authentication, unauthenticated rejection, plugin hot discovery,
  exact instance stop, and registration cleanup.
- Build and smoke commands never replace the active binary.
- Production activation remains a separate user-authorized operation.

### Owners

- `script/build-custom-windows.ps1`
- `packages/cli/script/service-smoke.ts`

### Acceptance evidence

- Windows build completes with expected Bun and binary versions.
- The release path runs
  `pwsh -File .\script\build-custom-windows.ps1 -RunServiceSmoke`.
- Service smoke passes against isolated state using the compiled distribution
  binary rather than a development server.
- Exported artifact hashes match.

## Explicitly Not Preserved

The following historical behavior must not return during an upstream sync:

- Legacy Session writers, execution loops, or runtime fallback.
- Dual writes between V1 and V2 stores.
- Historical standalone `packages/openai` or `packages/llm` runtimes.
- Permanent supplier identity locking through `remoteStateBindingID`.
- Old V1 prompt-cache transformation blocks and duplicate cost calculators.
- The historical custom subagent center.
- V1 component files copied wholesale into the V2 TUI.
- Historical migrations replayed as new V2 migrations.

## Upstream Sync Procedure

1. Record the current custom HEAD, official upstream HEAD, merge base, and a
   clean worktree check.
2. Refresh official refs without merging.
3. Generate and retain three complete changed-path reports:
   - old upstream to old custom;
   - old upstream to new upstream;
   - new upstream to new custom after integration.
4. Map every old and new local-delta path to one or more stable IDs or an
   explicit non-functional bucket. Add a stable ID before implementation if a
   new product capability is discovered. Unclassified paths reject the sync.
5. Update the Audit Snapshot and review every preservation ID against upstream.
6. Create an isolated integration branch. Never synchronize directly on the
   active production branch.
7. Prefer official owners for upstream-equivalent infrastructure. Reapply only
   the documented local semantic delta.
8. For each ID, record one outcome:
   - preserved by local code;
   - replaced by verified upstream-equivalent behavior;
   - intentionally removed by an explicit product decision.
9. Review every overlapping file even when Git auto-merges it. Route identity,
   provider capability, auxiliary request boundaries, durable projection, and
   TUI state are semantic conflict areas.
10. Run the item-specific acceptance evidence and package typechecks.
11. Build an isolated Windows candidate and run the compiled service smoke.
12. Do not activate the candidate or migrate the production database as part of
    synchronization verification.

## Minimum Verification Matrix

### AI

- OpenAI Responses provider and provider-package tests.
- Provider-option type fixtures and request-body lowering tests.
- Hosted web-search and image-generation factory/replay tests.
- Automatic and explicit remote compaction tests.
- Incomplete-stream and 16,384 input-item boundary tests.
- AI package typecheck.

### Core

- Model resolver and V1 config normalization tests.
- Session compaction, remote replay, runner, and runner-message tests.
- Tool-result pruning and pairing tests.
- Subagent continuation tests.
- Session rules location, start directory, create, move/fork, and migration
  tests.
- Core typecheck and migration-generation check.

### TUI And CLI

- Main and Mini i18n parity tests.
- Main and Mini compaction status/notice tests.
- Focused prompt, footer, Session, dialog, and non-interactive run tests.
- TUI and CLI typechecks.

### Release

- Full WebUI Windows build.
- Isolated compiled-service smoke.
- Artifact length and SHA-256 identity checks.
- Copy-only database rehearsal only when migration behavior changed or before
  production activation.
- Context-repair idempotency and post-VACUUM verification when those operational
  paths are used.

## Completion Record Template

Record the synchronization identity before filling the table:

```text
old_upstream=
old_custom=
new_upstream=
new_custom=
merge_base=
worktree_clean_before=
worktree_clean_after=
old_local_delta_report=
upstream_delta_report=
new_local_delta_report=
path_closure_check=
```

Each report entry must include its repository path, path count, and SHA-256.
Copy this table into the synchronization change record and fill every row:

| ID                   | Outcome | Evidence | Reviewer | Notes |
| -------------------- | ------- | -------- | -------- | ----- |
| `CUST-RESP-001`      | pending |          |          |       |
| `CUST-RESP-002`      | pending |          |          |       |
| `CUST-RESP-003`      | pending |          |          |       |
| `CUST-RESP-004`      | pending |          |          |       |
| `CUST-COMP-001`      | pending |          |          |       |
| `CUST-COMP-002`      | pending |          |          |       |
| `CUST-CONTEXT-001`   | pending |          |          |       |
| `CUST-TRANSPORT-001` | pending |          |          |       |
| `CUST-SUBAGENT-001`  | pending |          |          |       |
| `CUST-RULES-001`     | pending |          |          |       |
| `CUST-TUI-001`       | pending |          |          |       |
| `CUST-TUI-002`       | pending |          |          |       |
| `CUST-MIGRATION-001` | pending |          |          |       |
| `CUST-MIGRATION-002` | pending |          |          |       |
| `CUST-OPS-001`       | pending |          |          |       |
