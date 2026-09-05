export * as SessionCompaction from "./compaction.js"

import { LLMClient, LLMEvent, Message, type ContentPart, type LLMRequest } from "@opencode-ai/ai"
import * as OpenAIResponses from "@opencode-ai/ai/protocols/openai-responses"
import type { LLMClientShape, StreamOptions } from "@opencode-ai/ai/route"
import { SessionError } from "@opencode-ai/schema/session-error"
import { Context, Effect, Layer, Stream } from "effect"
import { Bus } from "../bus.js"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { llmClient } from "../effect/app-node-platform.js"
import { SessionEvent } from "./event.js"
import type { SessionContext } from "./context.js"
import type { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { toSessionError } from "./to-session-error.js"
import { Token } from "../util/token.js"
import { SessionUsage } from "./usage.js"
import { Agent } from "../agent.js"
import { State } from "../state.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import type { AgentNotFoundError } from "./error.js"
import type { Instructions } from "../instructions/index.js"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 15_000
const OUTPUT_TOKEN_MAX = 32_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const IMAGE_TOKEN_ESTIMATE = 1_500
const PDF_TOKEN_ESTIMATE = 2_000
const REMOTE_FALLBACK_GRACE = 0.05
const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List files and directories that are important to the conversation. Include paths outside the current working directory when relevant. If none are relevant, write "(none)".
- \`[exact path]\`: [why it matters]

## Additional Context
- [important facts, assumptions, unresolved questions, exact references, or other context needed to continue that does not fit above; when uncertain, preserve it here, or "(none)"]
</template>`

const SUMMARY_RULES = `Rules:
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not include ambient environment metadata such as the session ID, current working directory, repository root, current branch, or worktree path. The next agent receives current environment information separately. Include these details only when they directly affect the task.
- Do not mention the summary process or that context was compacted.`

export type Settings = {
  auto: boolean
  buffer: number
  tokens: number
}

export type Editor = {
  configure: (settings: Partial<Settings>) => void
}

type Dependencies = {
  readonly bus: Bus.Interface
  readonly llm: Pick<LLMClientShape, "compact" | "stream">
}

export type AutoInput = {
  readonly context: SessionContext.Loaded
  readonly prepare: SessionModelRequest.Interface["prepare"]
  readonly remote?: RemoteRequest
}

type ThresholdInput = {
  readonly messages: readonly SessionMessage.Info[]
  readonly resolved: SessionRunnerModel.Resolved
}

type RequiredInput = ThresholdInput & {
  readonly context?: SessionContext.Loaded
  readonly request?: LLMRequest
}

type ManualBase = {
  readonly session: SessionSchema.Info
  readonly messages: readonly SessionMessage.Info[]
  readonly inputID: SessionMessage.ID
  readonly started?: boolean
  readonly prepare: SessionModelRequest.Interface["prepare"]
  /** Builds the normal post-hook conversation prefix for a native trigger. */
  readonly prepareRemote?: (resolved: SessionRunnerModel.Resolved) => Effect.Effect<RemoteRequest, unknown>
}

export type ManualInput = ManualBase &
  (
    | {
        /** Selects context and resolves its model once after content planning. */
        readonly resolveContext: (
          session: SessionSchema.Info,
        ) => Effect.Effect<
          SessionContext.Loaded & { readonly instructionUpdate: string },
          SessionRunnerModel.Error | AgentNotFoundError | Instructions.InitializationBlocked
        >
        readonly resolveModel?: never
      }
    | {
        /** Compatibility seam for direct compaction consumers that already assembled their messages. */
        readonly resolveModel: SessionContext.Interface["resolveModel"]
        readonly resolveContext?: never
      }
  )

type ExecuteInput = AutoInput & {
  readonly reason: SessionMessage.Compaction["reason"]
  readonly inputID?: SessionMessage.ID
  readonly started?: boolean
  readonly instructionUpdate?: string
}

export type RemoteRequest = {
  readonly request: LLMRequest
  readonly options?: StreamOptions
}

export type FallbackInput = {
  readonly session: SessionSchema.Info
  readonly remote: RemoteRequest
}

type RemotePlan = {
  readonly session: SessionSchema.Info
  readonly remote: RemoteRequest
  readonly reason: SessionMessage.Compaction["reason"]
  readonly inputID?: SessionMessage.ID
  readonly started?: boolean
}

type RemoteOutcome =
  | { readonly status: "completed"; readonly remote: true; readonly replacement?: readonly Message[] }
  | { readonly status: "failed"; readonly error: SessionMessage.CompactionFailed["error"]; readonly remote: true }

export type Outcome =
  | Pick<SessionMessage.CompactionCompleted, "status">
  | Pick<SessionMessage.CompactionFailed, "status" | "error">
  | RemoteOutcome

export interface Interface extends State.Transformable<Editor> {
  readonly enabled: () => boolean
  readonly required: (input: RequiredInput) => boolean
  readonly remoteThreshold: (input: ThresholdInput) => number | undefined
  readonly compact: (input: AutoInput) => Effect.Effect<Outcome>
  readonly compactManual: (input: ManualInput) => Effect.Effect<Outcome>
  readonly compactFallback: (input: FallbackInput) => Effect.Effect<RemoteOutcome>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const estimateTokens = (input: RequiredInput) => {
  const index = input.messages.findLastIndex(
    (message) =>
      message.type === "assistant" &&
      !message.error &&
      message.tokens !== undefined &&
      message.tokens.input + message.tokens.cache.read + message.tokens.cache.write > 0,
  )
  const last = input.messages[index]
  // Keep the anchor's local tool results: they are not covered by its provider usage.
  const added = SessionModelRequest.unsupportedParts(
    toLLMMessages(input.messages.slice(Math.max(0, index)), input.resolved.ref),
    input.resolved.capabilities,
  )
    .filter((message) => message.role !== "assistant" || message.id !== last?.id)
    .reduce((sum, message) => sum + message.content.reduce((sum, part) => sum + estimatePart(part), 0), 0)
  if (last?.type === "assistant" && last.tokens)
    return (
      added +
      last.tokens.input +
      last.tokens.cache.read +
      last.tokens.cache.write +
      last.tokens.output +
      last.tokens.reasoning
    )
  if (!input.context) return added
  const transcript = SessionModelRequest.baseTranscript({
    agent: input.context.agent.info,
    model: input.resolved,
    tools: input.context.tools,
    initial: input.context.initial,
    messages: [],
  })
  return (
    added +
    transcript.system.reduce((sum, part) => sum + Token.estimate(part.text), 0) +
    input.context.tools.definitions.reduce(
      (sum, tool) => sum + Token.estimate(tool.name + tool.description + JSON.stringify(tool.inputSchema)),
      0,
    )
  )
}

const estimateMedia = (mime: string) => {
  const type = mime.toLowerCase()
  return type.startsWith("image/") ? IMAGE_TOKEN_ESTIMATE : type === "application/pdf" ? PDF_TOKEN_ESTIMATE : 0
}

const estimatePart = (part: ContentPart): number => {
  if (part.type === "text" || part.type === "reasoning") return Token.estimate(part.text)
  if (part.type === "media") return estimateMedia(part.mediaType)
  if (part.type === "tool-call") return Token.estimate(part.name + (JSON.stringify(part.input) ?? ""))
  if (part.type === "compaction") return typeof part.text === "string" ? Token.estimate(part.text) : 0
  if (part.result.type === "content")
    return part.result.value.reduce(
      (sum, content) => sum + (content.type === "text" ? Token.estimate(content.text) : estimateMedia(content.mime)),
      0,
    )
  return Token.estimate(
    typeof part.result.value === "string" ? part.result.value : (JSON.stringify(part.result.value) ?? ""),
  )
}

export const truncateToolOutput = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value
  let end = 0
  for (let count = 0; count < TOOL_OUTPUT_MAX_CHARS && end < value.length; count++) {
    const code = value.charCodeAt(end)
    end +=
      code >= 0xd800 && code <= 0xdbff && value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff
        ? 2
        : 1
  }
  if (end === value.length) return value
  return `${value.slice(0, end)}\n[truncated]`
}

export const remoteFallbackRequired = (input: {
  readonly threshold: number | undefined
  readonly tokens: ReturnType<typeof SessionUsage.tokens>
  readonly checkpointed: boolean
}) => {
  if (input.threshold === undefined || input.checkpointed) return false
  const used =
    input.tokens.input +
    input.tokens.output +
    input.tokens.reasoning +
    input.tokens.cache.read +
    input.tokens.cache.write
  return used > input.threshold * (1 + REMOTE_FALLBACK_GRACE)
}

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serializeRecentMessage = (message: SessionMessage.Info) => {
  // Checkpoints and instruction updates are handled outside the serialized tail.
  if (message.type === "compaction" || message.type === "system") return ""
  if (message.type === "user") {
    const files =
      message.files?.map(
        (file) =>
          `[Attached ${file.mime}: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")}]`,
      ) ?? []
    const skills =
      message.skills?.flatMap((skill) =>
        skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`],
      ) ?? []
    return [...skills, `[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "location-switched")
    return `[User]: The working directory has been changed to ${message.location.directory}.`
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncateToolOutput(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "skill") return `[Skill activated: ${message.name}]\n${message.text}`
  if (message.type === "shell")
    return message.metadata?.background === true
      ? ""
      : `[Shell]: ${message.command}\n${truncateToolOutput(message.output?.output ?? "")}`
  return ""
}

const splitHistory = (messages: readonly SessionMessage.Info[], keepTokens: number) => {
  const tailStart = findTailStart(messages, keepTokens)
  if (tailStart === undefined) return
  return {
    messages: messages.slice(0, tailStart),
    recent: messages.slice(tailStart).map(serializeRecentMessage).filter(Boolean).join("\n\n"),
  }
}

const findTailStart = (messages: readonly SessionMessage.Info[], keepTokens: number) => {
  const conversation = messages.flatMap((message, index) => {
    const text = serializeRecentMessage(message)
    return text ? [{ message, text, index }] : []
  })
  if (conversation.length === 0) return undefined

  // Keep at least the newest entry, even if it exceeds the allowance.
  let total = 0
  let start = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index].text)
    if (start < conversation.length && next > keepTokens) break
    total = next
    start = index
  }

  // Start at a user boundary so an assistant's tool calls and results stay together.
  while (start > 0 && conversation[start].message.type !== "user") start--
  if (start > 0) return conversation[start].index

  // If everything fits, retain only the latest exchange to leave an older prefix to summarize.
  const latestUser = conversation.findLastIndex((item) => item.message.type === "user")
  if (latestUser > 0) return conversation[latestUser].index

  const previousSummary = messages.findLast(
    (message): message is SessionMessage.CompactionCompleted =>
      message.type === "compaction" && message.status === "completed",
  )
  // Without an older retained tail to summarize, summarize everything and retain nothing.
  return previousSummary?.recent ? conversation[0].index : messages.length
}

export const buildPrompt = (update: boolean) => {
  const shared = [
    "Summarize only the history shown. More recent context may be retained and presented after this summary.",
    SUMMARY_TEMPLATE,
    SUMMARY_RULES,
    "Do not continue the task or call tools.",
    "Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
  ]
  if (update) {
    return [
      "Update the existing checkpoint in the conversation above into one consolidated summary.",
      "Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale. When uncertain and there is no conflict, retain it under Additional Context.",
      "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.",
      "Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>`, `<summary>`, or `<recent-context>` wrapper tags from the previous checkpoint.",
      ...shared,
    ].join("\n\n")
  }
  return [
    "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
    ...shared,
  ].join("\n\n")
}

const make = (dependencies: Dependencies) => {
  const state = State.create<Settings, Editor>({
    name: "session-compaction",
    initial: () => ({ auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS }),
    editor: (editor) => ({
      configure: (settings) => {
        if (settings.auto !== undefined) editor.auto = settings.auto
        if (settings.buffer !== undefined) editor.buffer = settings.buffer
        if (settings.tokens !== undefined) editor.tokens = settings.tokens
      },
    }),
  })
  const failed = Effect.fnUntraced(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly reason: SessionMessage.Compaction["reason"]
    readonly error: SessionError.Error
    readonly inputID?: SessionMessage.ID
    readonly remote?: true
  }) {
    yield* dependencies.bus.publish(SessionEvent.Compaction.Failed, input)
    return input.remote
      ? ({ status: "failed" as const, error: input.error, remote: true } as const)
      : ({ status: "failed" as const, error: input.error } as const)
  })
  const execute = Effect.fn("SessionCompaction.execute")(function* (input: ExecuteInput) {
    const context = input.context
    const history = splitHistory(context.messages, state.get().tokens)
    if (!history)
      return yield* failed({
        sessionID: context.session.id,
        reason: input.reason,
        error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
        inputID: input.inputID,
      })
    if (!input.started)
      yield* dependencies.bus.publish(SessionEvent.Compaction.Started, {
        sessionID: context.session.id,
        reason: input.reason,
        recent: history.recent,
        inputID: input.inputID,
      })

    const chunks: string[] = []
    let failure: SessionError.Error | undefined
    let usage: SessionUsage.Recorded | undefined
    let providerState: SessionMessage.ProviderState | undefined
    const recordUsage = Effect.suspend(() =>
      usage
        ? dependencies.bus.publish(SessionEvent.UsageRecorded, {
            sessionID: context.session.id,
            source: "compaction",
            ...usage,
          })
        : Effect.void,
    )
    const transcript = SessionModelRequest.baseTranscript({
      agent: context.agent.info,
      model: context.model,
      tools: context.tools,
      initial: context.initial,
      messages: history.messages,
    })
    const prepared = yield* input.prepare({
      scope: {
        session: context.session,
        agentID: Agent.ID.make("compaction"),
        contextAgentID: context.agent.id,
        model: context.model,
        tools: context.tools,
      },
      transcript: {
        system: transcript.system,
        messages: [
          ...transcript.messages,
          ...(input.instructionUpdate ? [Message.system(input.instructionUpdate)] : []),
          Message.user(
            buildPrompt(
              history.messages.some((message) => message.type === "compaction" && message.status === "completed"),
            ),
          ),
        ],
      },
      contextHooks: false,
    })
    // Tool calls are ignored: they never enter follow-up history or need fabricated results.
    yield* dependencies.llm.stream(prepared.request, prepared.options).pipe(
      Stream.runForEach((event) => {
        if (LLMEvent.is.providerError(event))
          failure = {
            type: event.classification === "context-overflow" ? "provider.invalid-request" : "provider.error",
            message: event.message,
          }
        if (LLMEvent.is.textDelta(event)) {
          chunks.push(event.text)
          return dependencies.bus.publish(SessionEvent.Compaction.Delta, {
            sessionID: context.session.id,
            text: event.text,
          })
        }
        if (LLMEvent.is.stepFinish(event)) {
          providerState = event.providerMetadata?.[transcript.providerMetadataKey]
          const step = SessionUsage.record(event.usage, context.model.cost)
          usage = usage ? SessionUsage.add(usage, step) : step
        }
        return Effect.void
      }),
      Effect.catchTag("AI.Error", (error) =>
        Effect.sync(() => {
          failure = toSessionError(error)
        }),
      ),
      Effect.onInterrupt(() =>
        recordUsage.pipe(
          Effect.andThen(
            input.reason === "auto"
              ? failed({
                  sessionID: context.session.id,
                  reason: input.reason,
                  error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
                  inputID: input.inputID,
                }).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ),
    )
    yield* recordUsage
    const summary = chunks.join("")
    if (failure || !summary.trim()) {
      const error = failure ?? { type: "compaction.failed" as const, message: "Compaction produced no summary" }
      return yield* failed({
        sessionID: context.session.id,
        reason: input.reason,
        error,
        inputID: input.inputID,
      })
    }
    yield* dependencies.bus.publish(SessionEvent.Compaction.Ended, {
      sessionID: context.session.id,
      reason: input.reason,
      model: context.model.ref,
      providerState,
      text: summary,
      recent: history.recent,
    })
    return { status: "completed" as const }
  })
  const executeRemote = Effect.fn("SessionCompaction.executeRemote")(function* (plan: RemotePlan) {
    if (!plan.started)
      yield* dependencies.bus.publish(SessionEvent.Compaction.Started, {
        sessionID: plan.session.id,
        reason: plan.reason,
        recent: "",
        remote: true,
        inputID: plan.inputID,
      })
    const compacted = yield* OpenAIResponses.compactV2(
      plan.remote.request,
      dependencies.llm.stream,
      plan.remote.options,
    ).pipe(
      Effect.map((output) => ({ output }) as const),
      Effect.catchTag("AI.Error", (error) => Effect.succeed({ error: toSessionError(error) } as const)),
    )
    if ("error" in compacted) {
      const outcome = yield* failed({
        sessionID: plan.session.id,
        reason: plan.reason,
        error: compacted.error,
        inputID: plan.inputID,
        remote: true,
      })
      return { status: "failed" as const, error: outcome.error, remote: true } as const
    }
    const item = compacted.output[0]
    yield* Effect.uninterruptible(
      dependencies.bus.publishAll([
        [SessionEvent.Compaction.RemoteItem, { sessionID: plan.session.id, reset: true, item }],
        [SessionEvent.Compaction.Ended, { sessionID: plan.session.id, reason: plan.reason, text: "", recent: "" }],
      ]),
    )
    return { status: "completed" as const, remote: true } as const
  })
  const executeExplicit = Effect.fn("SessionCompaction.executeExplicit")(function* (plan: RemotePlan) {
    if (!LLMClient.canCompact(plan.remote.request))
      return {
        status: "failed" as const,
        error: { type: "compaction.failed" as const, message: "The selected route cannot compact this request" },
        remote: true as const,
      }
    const operation = dependencies.llm.compact
    if (!operation)
      return {
        status: "failed" as const,
        error: { type: "compaction.failed" as const, message: "The configured LLM client cannot compact this request" },
        remote: true as const,
      }
    const compacted = yield* operation(plan.remote.request, plan.remote.options).pipe(
      Effect.map((output) => ({ output }) as const),
      Effect.catchTag("AI.Error", (error) => Effect.succeed({ error: toSessionError(error) } as const)),
    )
    if ("error" in compacted) return { status: "failed" as const, error: compacted.error, remote: true } as const
    const checkpoints = compacted.output.replacement.flatMap((message) =>
      message.content.flatMap((part) => (part.type === "compaction" && part.encrypted !== undefined ? [part] : [])),
    )
    if (checkpoints.length !== 1)
      return {
        status: "failed" as const,
        error: {
          type: "provider.invalid-output" as const,
          message: "Explicit compaction did not produce exactly one encrypted checkpoint",
        },
        remote: true as const,
      }
    const checkpoint = checkpoints[0]
    const item = {
      type: "compaction",
      ...(checkpoint.id === undefined ? {} : { id: checkpoint.id }),
      encrypted_content: checkpoint.encrypted,
    }
    yield* Effect.uninterruptible(
      dependencies.bus.publishAll([
        [
          SessionEvent.Compaction.Started,
          {
            sessionID: plan.session.id,
            reason: plan.reason,
            recent: "",
            remote: true,
            inputID: plan.inputID,
          },
        ],
        [SessionEvent.Compaction.RemoteItem, { sessionID: plan.session.id, reset: true, item }],
        [SessionEvent.Compaction.Ended, { sessionID: plan.session.id, reason: plan.reason, text: "", recent: "" }],
      ]),
    )
    return { status: "completed" as const, remote: true, replacement: compacted.output.replacement } as const
  })
  const compact = Effect.fn("SessionCompaction.compact")(function* (input: AutoInput) {
    if (input.remote && LLMClient.canCompact(input.remote.request))
      return yield* executeExplicit({ session: input.context.session, remote: input.remote, reason: "auto" })
    if (OpenAIResponses.supportsCompaction(input.context.model.model))
      return yield* failed({
        sessionID: input.context.session.id,
        reason: "auto",
        error: {
          type: "compaction.failed",
          message: "Automatic remote compaction is provider-managed through the Responses context threshold",
        },
      })
    return yield* execute({ ...input, reason: "auto" })
  })
  const promptCeiling = (input: ThresholdInput) => {
    const config = state.get()
    const limit = input.resolved.limit
    if (limit.context <= 0) return undefined
    const ceiling = Math.min(
      limit.input === undefined ? Number.POSITIVE_INFINITY : limit.input - config.buffer,
      limit.context - Math.max(Math.min(limit.output, OUTPUT_TOKEN_MAX), config.buffer),
    )
    return ceiling
  }
  const remoteThreshold = (input: ThresholdInput) => {
    if (!state.get().auto || !OpenAIResponses.supportsCompaction(input.resolved.model)) return undefined
    const ceiling = promptCeiling(input)
    return ceiling !== undefined && Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : undefined
  }
  const required = (input: RequiredInput) => {
    const config = state.get()
    if (!config.auto) return false
    if (remoteThreshold(input) !== undefined) return false
    if (input.request && LLMClient.canCompact(input.request)) {
      const ceiling = promptCeiling(input)
      return ceiling !== undefined && Number.isSafeInteger(ceiling) && ceiling > 0 && estimateTokens(input) >= ceiling
    }
    // Run the completed checkpoint before considering another automatic compaction.
    const last = input.messages.at(-1)
    if (last?.type === "compaction" && last.status === "completed") return false
    const ceiling = promptCeiling(input)
    if (ceiling === undefined) return false
    return estimateTokens(input) >= ceiling
  }
  const compactManual = Effect.fn("SessionCompaction.compactManual")(function* (input: ManualInput) {
    if (findTailStart(input.messages, state.get().tokens) === undefined)
      return yield* failed({
        sessionID: input.session.id,
        reason: "manual",
        error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
        inputID: input.inputID,
      })
    const selected = input.resolveContext
      ? yield* input.resolveContext(input.session).pipe(
          Effect.catch((cause) =>
            failed({
              sessionID: input.session.id,
              reason: "manual",
              error: toSessionError(cause),
              inputID: input.inputID,
            }),
          ),
        )
      : undefined
    if (selected && "status" in selected) return selected
    const resolved = selected
      ? selected.model
      : yield* (input.resolveModel ?? (() => Effect.die(new Error("Compaction model resolver is unavailable"))))(
          input.session,
        ).pipe(
          Effect.catch((cause) =>
            failed({
              sessionID: input.session.id,
              reason: "manual",
              error: toSessionError(cause),
              inputID: input.inputID,
            }),
          ),
        )
    if ("status" in resolved) return resolved
    if (OpenAIResponses.supportsCompaction(resolved.model)) {
      if (!input.prepareRemote)
        return yield* failed({
          sessionID: input.session.id,
          reason: "manual",
          error: { type: "compaction.failed", message: "Native remote compaction request was not prepared" },
          inputID: input.inputID,
          remote: true,
        })
      const prepared = yield* input.prepareRemote(resolved).pipe(
        Effect.map((remote) => ({ remote }) as const),
        Effect.catch((cause) => Effect.succeed({ error: toSessionError(cause) } as const)),
      )
      if ("error" in prepared)
        return yield* failed({
          sessionID: input.session.id,
          reason: "manual",
          error: prepared.error,
          inputID: input.inputID,
          remote: true,
        })
      return yield* executeRemote({
        session: input.session,
        remote: prepared.remote,
        reason: "manual",
        inputID: input.inputID,
        started: input.started,
      })
    }
    if (resolved.model.route.compact) {
      if (!input.prepareRemote) {
        const outcome = yield* failed({
          sessionID: input.session.id,
          reason: "manual",
          error: { type: "compaction.failed", message: "Explicit remote compaction request was not prepared" },
          inputID: input.inputID,
          remote: true,
        })
        return { status: "failed", error: outcome.error, remote: true } satisfies RemoteOutcome
      }
      const prepared = yield* input.prepareRemote(resolved).pipe(
        Effect.map((remote) => ({ remote }) as const),
        Effect.catch((cause) => Effect.succeed({ error: toSessionError(cause) } as const)),
      )
      if ("error" in prepared) {
        const outcome = yield* failed({
          sessionID: input.session.id,
          reason: "manual",
          error: prepared.error,
          inputID: input.inputID,
          remote: true,
        })
        return { status: "failed", error: outcome.error, remote: true } satisfies RemoteOutcome
      }
      if (!LLMClient.canCompact(prepared.remote.request)) {
        const outcome = yield* failed({
          sessionID: input.session.id,
          reason: "manual",
          error: { type: "compaction.failed", message: "Prepared request lost explicit compaction capability" },
          inputID: input.inputID,
          remote: true,
        })
        return { status: "failed", error: outcome.error, remote: true } satisfies RemoteOutcome
      }
      return yield* executeExplicit({
        session: input.session,
        remote: prepared.remote,
        reason: "manual",
        inputID: input.inputID,
      })
    }
    if (!selected) {
      const agentID = input.session.agent ?? Agent.defaultID
      return yield* execute({
        context: {
          session: input.session,
          agent: {
            id: agentID,
            info: Agent.Info.default(agentID),
          },
          model: resolved,
          initial: "",
          messages: input.messages,
          tools: {
            definitions: [],
            execute: () => Effect.die(new Error("Tools are unavailable without selected Session context")),
          },
        },
        prepare: input.prepare,
        reason: "manual",
        inputID: input.inputID,
        started: input.started,
      })
    }
    return yield* execute({
      context: selected,
      instructionUpdate: selected.instructionUpdate,
      prepare: input.prepare,
      reason: "manual",
      inputID: input.inputID,
      started: input.started,
    })
  })
  const compactFallback = Effect.fn("SessionCompaction.compactFallback")((input: FallbackInput) =>
    executeRemote({ session: input.session, remote: input.remote, reason: "auto" }),
  )
  return Service.of({
    transform: state.transform,
    reload: state.reload,
    enabled: () => state.get().auto,
    required,
    remoteThreshold,
    compact,
    compactManual,
    compactFallback,
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    return make({ bus, llm })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, llmClient],
})
