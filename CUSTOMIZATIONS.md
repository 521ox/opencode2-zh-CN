# OpenCode2 zh-CN Public Customization Contract

## Purpose and Authority

OpenCode2 zh-CN is an independent community fork of
[anomalyco/opencode](https://github.com/anomalyco/opencode). It is not
affiliated with, authorized by, sponsored by, or endorsed by anomalyco or the
upstream maintainers.

This root document owns the stable public customization boundary. Current
source and focused tests are the executable owners. If source, tests, and
documentation disagree, stop the integration and reconcile the contract; do
not silently select whichever text is easiest to preserve.

Upstream changes have been selectively reviewed through
[`0808ebc3`](https://github.com/anomalyco/opencode/commit/0808ebc3c52286f5a3a602f82f069ae597f86469).
That revision is not a direct ancestor of this fork, and this statement does
not claim that every upstream change in the reviewed range was integrated.

## Product Boundary

- V2 packages own current runtime behavior. Fork-specific V1 migration and
  rehearsal tools are retired and must not be restored.
- Preserve behavior and tests, not historical file layout. Prefer an upstream
  owner only after semantic equivalence is demonstrated.
- Keep provider credentials, endpoints, prompts, response IDs, session data,
  generated memory snapshots, and machine evidence out of fixtures and docs.
- The source runtime prerequisite is Bun 1.3.14, as declared by the root
  `packageManager`. Historical canary build modes are not a current product
  contract.

## Complete Provider, Protocol, and Operation Whitelist

Capabilities are granted by package ownership, the selected protocol, and the
operations implemented by that route. Provider IDs, display names, base URLs,
and shared labels are not capability evidence.

| Package / selected route | Required behavior | Remote compaction owner |
| --- | --- | --- |
| `@opencode-ai/ai/providers/openai` | Full native OpenAI Responses; explicit native storage policy and optional native WebSocket | Native in-band automatic and trigger operations |
| `@opencode-ai/ai/providers/openai/responses` | Alias of the same native OpenAI owner | Same as native parent |
| `@opencode-ai/ai/providers/openai-compatible/responses` | Generic Responses-compatible HTTP; final dispatch forces `store: false` and strips native compaction fields | None; local summary |
| `aisdk:@ai-sdk/openai` | Compatibility selector mapped to generic compatible Responses; it does not execute the AI SDK OpenAI provider | None; local summary |
| `@opencode-ai/ai/providers/openai-compatible` | Generic OpenAI-compatible Chat Completions | None; local summary |
| `@opencode-ai/ai/providers/xai` + dedicated Responses protocol | Official xAI Responses; final dispatch forces `store: false` | Dedicated client `POST /responses/compact` operation |
| `@opencode-ai/ai/providers/xai` + Chat protocol | xAI Chat Completions | None; local summary |

DeepSeek, Anthropic, Azure, Modal, Copilot, Chat routes, and all other routes not
explicitly granted an operation above use local-summary compaction. Generic
compatible routes must not inherit native hosted tools, storage, WebSocket, or
remote-compaction behavior.

### Native OpenAI Responses compaction

- Ordinary `/responses` requests use
  `context_management: [{ type: "compaction", compact_threshold: ... }]`.
- Manual compaction and bounded overflow recovery use the same ordinary
  `/responses` stream with a final `{ "type": "compaction_trigger" }` input.
- No native OpenAI production path calls `/responses/compact`.
- A missing checkpoint or trigger failure is visible and does not fall back to
  local summary.

### Official xAI Responses compaction

- Threshold crossing and manual compaction each issue exactly one
  `<baseURL>/responses/compact` request before ordinary generation.
- The selected endpoint or proxy must implement that operation and return one
  opaque, replayable `encrypted_content` compaction item.
- A 404, malformed response, or missing item fails visibly without local
  fallback or durable transcript mutation.
- xAI Chat and look-alike routes do not own this operation.

### Shared compaction settings

Current V2 configuration fields are `compaction.auto` (default `true`),
`compaction.prune` (default `false`), `compaction.buffer` (default `20000`), and
`compaction.keep.tokens` (default `15000`). `keep.tokens` applies only to the
tail retained for local summary. There is no top-level `compact_threshold`.

With buffer `B`, the remote prompt ceiling is:

```text
min(inputLimit - B,
    contextLimit - max(min(outputLimit, 32000), B))
```

A missing input limit contributes infinity. A non-positive or non-safe-integer
result is unusable and must not trigger remote compaction.

## Public Customization Inventory

The public customization whitelist preserves these behavior groups:

1. Native OpenAI ownership, compatible-route separation, hosted-tool ownership,
   strict request lowering, stream completion, and input boundaries.
2. Native OpenAI automatic/manual compaction and official xAI explicit remote
   compaction, each with fail-visible route-specific behavior.
3. Pressure-gated request-only tool-result pruning and deterministic checkpoint
   projection/replay.
4. Cross-process Session execution leases and bounded process-local Job
   retention.
5. Direct-child subagent continuation, complete final conclusions, background
   completion, and durable continuation admission.
6. Protected root-Session rules context and request-time Plan reminder
   reconciliation.
7. Fork-owned `environment_tools` and argv-only `direct_exec` with separate
   catalog and execution permissions.
8. Code Mode-only pinned `opencode.session_move`, limited to the current Session
   or an owned direct child.
9. Simplified Chinese-first TUI, compaction status, tab/cache ownership, prompt
   navigation, exact child IDs, MCP status activation, and background-child
   navigation.
10. Plugin management in CLI/TUI, `/stats` and CLI stats, App/WebUI Copy Session
    ID, command subagents/background Jobs, and the root `update` alias.
11. Idempotent child-process output settlement and retained-Location/MCP shutdown
    containment.
12. Behavior-preserving request-path allocation/read optimizations.

Windows persistent terminal panes remain default-off. Internal ACP and
diagnostic surfaces are not ordinary user UI and are not promoted as public
workflow entry points.

## Synchronization Rule

For every upstream synchronization:

1. classify each affected stable customization ID;
2. identify the current upstream and fork owners;
3. preserve, rebase the semantic delta, or adopt an upstream-equivalent owner;
4. run focused evidence capable of falsifying the affected contract;
5. record exclusions and residual risks without treating a clean textual merge
   as acceptance evidence.

Retired migration behavior, private operational evidence, build sidecars,
machine diagnostics, and local audit data are not public product features.
