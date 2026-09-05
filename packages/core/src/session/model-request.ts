export * as SessionModelRequest from "./model-request.js"

import { HttpOptions, LanguageModel, LLM, LLMRequest, Message, SystemPart, ToolResultPart } from "@opencode-ai/ai"
import { webSearch as openAIWebSearch } from "@opencode-ai/ai/providers/openai"
import * as OpenAIResponses from "@opencode-ai/ai/protocols/openai-responses"
import type { StreamOptions } from "@opencode-ai/ai/route"
import type { Entry } from "@opencode-ai/schema/config"
import type { Content } from "@opencode-ai/schema/tool"
import { Cause, Config, Context, Effect, Layer, Option, Result, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { App } from "../app.js"
import { Config as CoreConfig } from "../config.js"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { PluginHooks } from "../plugin/hooks.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { Tool } from "../tool.js"
import { SessionModelTransport } from "./model-transport.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionSystemPrompt } from "./system-prompt.js"
import { TOOL_RESULT_PRUNE_METADATA, toLLMMessages, type ToolResultPruneInfo } from "./runner/to-llm-message.js"
import type { SessionMessage } from "./message.js"
import type { Agent } from "../agent.js"

const IMAGE_BYTES_TRIGGER = 25 * 1024 * 1024 // 25 MiB
const IMAGE_BYTES_TARGET = 15 * 1024 * 1024 // 15 MiB
const IMAGE_REMOVED =
  "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]"
const TOOL_RESULT_PRUNE_CONTEXT_RATIO = 0.8
const TOOL_RESULT_PRUNE_REMOTE_RATIO = 0.9
const TOOL_RESULT_MAX_CODE_POINTS = 8_192
const TOOL_RESULT_HEAD_CODE_POINTS = 4_096
const TOOL_RESULT_TAIL_CODE_POINTS = 1_024
const TOOL_RESULT_PRUNE_MARKER = Symbol("tool-result-prune")

const pruneToolResults = (entries: readonly Entry[]) =>
  entries
    .filter((entry) => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction?.prune === undefined ? [] : [entry.info.compaction.prune]))
    .at(-1) ?? false

const promptLimit = (limit: SessionRunnerModel.Resolved["limit"]) => {
  const values = [limit.context, limit.input].filter((value): value is number => value !== undefined && value > 0)
  return values.length > 0 ? Math.min(...values) : undefined
}

const base64Bytes = (value: string) => {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

const dataURIBytes = (value: string) => {
  const comma = value.indexOf(",")
  if (comma < 0) return Buffer.byteLength(value)
  const header = value.slice(0, comma)
  const payload = value.slice(comma + 1)
  return header.endsWith(";base64") ? base64Bytes(payload) : Buffer.byteLength(payload)
}

const promptEstimateReplacer = function (this: unknown, key: string, value: unknown) {
  if (key === TOOL_RESULT_PRUNE_METADATA) return undefined
  if (value instanceof Uint8Array) return `[binary:${value.byteLength}]`
  if (value instanceof ArrayBuffer) return `[binary:${value.byteLength}]`
  if (!this || typeof this !== "object") return value
  const parent = this as { readonly type?: unknown }
  if (key === "data" && parent.type === "media" && typeof value === "string") return `[media:${base64Bytes(value)}]`
  if (key === "uri" && parent.type === "file" && typeof value === "string" && value.startsWith("data:"))
    return `[media:${dataURIBytes(value)}]`
  return value
}

const JSON_OMITTED = Symbol("json-omitted")

const jsonStringLength = (value: string) => {
  let length = 2
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x0c ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x09
    ) {
      length += 2
      continue
    }
    if (code < 0x20) {
      length += 6
      continue
    }
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      length += 2
      index++
      continue
    }
    length += code >= 0xd800 && code <= 0xdfff ? 6 : 1
  }
  return length
}

const promptEstimateJSONLength = (
  value: unknown,
  key: string,
  parent: unknown,
  stack: unknown[],
): number | typeof JSON_OMITTED => {
  if (value && typeof value === "object") {
    const toJSON = (value as { readonly toJSON?: unknown }).toJSON
    if (typeof toJSON === "function") value = toJSON.call(value, key)
  }
  value = promptEstimateReplacer.call(parent, key, value)
  if (value instanceof Number || value instanceof String || value instanceof Boolean || value instanceof BigInt)
    value = value.valueOf()
  if (value === null) return 4
  if (typeof value === "string") return jsonStringLength(value)
  if (typeof value === "boolean") return value ? 4 : 5
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4
  if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt")
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return JSON_OMITTED
  if (stack.includes(value)) throw new TypeError("Converting circular structure to JSON")
  stack.push(value)
  try {
    if (Array.isArray(value)) {
      let length = 2
      const items = value.length
      for (let index = 0; index < items; index++) {
        if (index > 0) length++
        const item = promptEstimateJSONLength(value[index], String(index), value, stack)
        length += item === JSON_OMITTED ? 4 : item
      }
      return length
    }
    let length = 2
    let first = true
    for (const name of Object.keys(value)) {
      const item = promptEstimateJSONLength((value as Record<string, unknown>)[name], name, value, stack)
      if (item === JSON_OMITTED) continue
      if (!first) length++
      length += jsonStringLength(name) + 1 + item
      first = false
    }
    return length
  } finally {
    stack.pop()
  }
}

export const promptTokenEstimate = (request: Pick<LLMRequest, "system" | "messages" | "tools">) => {
  const length = promptEstimateJSONLength(
    { system: request.system, messages: request.messages, tools: request.tools },
    "",
    {},
    [],
  )
  return Math.max(0, Math.round((length === JSON_OMITTED ? 0 : length) / 4))
}

export const toolResultPruneThreshold = (contextWindow: number | undefined, compactThreshold?: number) => {
  const thresholds: number[] = []
  if (contextWindow !== undefined && contextWindow > 0)
    thresholds.push(Math.ceil(contextWindow * TOOL_RESULT_PRUNE_CONTEXT_RATIO))
  if (compactThreshold !== undefined && compactThreshold > 0)
    thresholds.push(Math.min(compactThreshold - 1, Math.ceil(compactThreshold * TOOL_RESULT_PRUNE_REMOTE_RATIO)))
  return thresholds.length > 0 ? Math.min(...thresholds) : undefined
}

export const shouldPruneToolResults = (
  estimatedPromptTokens: number,
  contextWindow: number | undefined,
  compactThreshold?: number,
) => {
  const threshold = toolResultPruneThreshold(contextWindow, compactThreshold)
  return threshold !== undefined && estimatedPromptTokens >= threshold
}

const truncateToolResultText = (value: string, outputPath?: string) => {
  const chars = Array.from(value)
  if (chars.length <= TOOL_RESULT_MAX_CODE_POINTS) return value
  const omitted = chars.length - TOOL_RESULT_HEAD_CODE_POINTS - TOOL_RESULT_TAIL_CODE_POINTS
  const location = outputPath === undefined ? "" : ` Full output: ${outputPath}`
  return `${chars.slice(0, TOOL_RESULT_HEAD_CODE_POINTS).join("")}\n\n[... ${omitted} characters trimmed for context.${location}]\n\n${chars
    .slice(chars.length - TOOL_RESULT_TAIL_CODE_POINTS)
    .join("")}`
}

/** ToolOutput's canonical plain-text view joins text fragments with newlines. */
const pureTextToolResult = (
  part: Extract<LLMRequest["messages"][number]["content"][number], { type: "tool-result" }>,
) => {
  if (part.result.type === "text") return typeof part.result.value === "string" ? part.result.value : undefined
  if (part.result.type !== "content") return undefined
  const text = part.result.value.flatMap((item) => (item.type === "text" ? [item.text] : []))
  return text.length === part.result.value.length ? text.join("\n") : undefined
}

const finalizeToolResults = (messages: LLMRequest["messages"], marker: symbol, project: boolean) => {
  let changed = false
  const projected = messages.map((message) => {
    let messageChanged = false
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part
      const internal = part.metadata?.[TOOL_RESULT_PRUNE_METADATA]
      const info: ToolResultPruneInfo | undefined =
        internal && typeof internal === "object" && "marker" in internal && internal.marker === marker
          ? {
              marker,
              outputPath:
                "outputPath" in internal && typeof internal.outputPath === "string" ? internal.outputPath : undefined,
              trustedSubagentFinal:
                "trustedSubagentFinal" in internal && internal.trustedSubagentFinal === true ? true : undefined,
            }
          : undefined
      // Hooks can replace or reorder request parts, so eligibility is derived from each final occurrence.
      const source =
        !part.providerExecuted && part.name !== "skill" && info?.trustedSubagentFinal !== true
          ? pureTextToolResult(part)
          : undefined
      const value = project && source !== undefined ? truncateToolResultText(source, info?.outputPath) : undefined
      const hadInternalMetadata = part.metadata !== undefined && TOOL_RESULT_PRUNE_METADATA in part.metadata
      if (!hadInternalMetadata && (value === undefined || value === source)) return part
      const metadata = part.metadata === undefined ? undefined : { ...part.metadata }
      if (metadata !== undefined) delete metadata[TOOL_RESULT_PRUNE_METADATA]
      changed = true
      messageChanged = true
      return ToolResultPart.make({
        id: part.id,
        name: part.name,
        result: value === undefined || value === source ? part.result : { type: "text", value },
        providerExecuted: part.providerExecuted,
        cache: part.cache,
        metadata: metadata !== undefined && Object.keys(metadata).length > 0 ? metadata : undefined,
        providerMetadata: part.providerMetadata,
      })
    })
    return messageChanged ? Message.make({ ...message, content }) : message
  })
  return changed ? projected : messages
}

export const projectLargeToolResults = (messages: LLMRequest["messages"], marker: symbol) =>
  finalizeToolResults(messages, marker, true)

export const stripToolResultPruneMetadata = (messages: LLMRequest["messages"], marker: symbol) =>
  finalizeToolResults(messages, marker, false)

const responsesWebSocketFlag = (providerID: string) =>
  `OPENCODE_EXPERIMENTAL_${providerID.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_RESPONSES_WEBSOCKET`

/** Failures a prepared execution can surface: infrastructure errors plus user declines resurfaced from the defect tunnel. */
export type ExecuteError = Tool.Error | Permission.DeclinedError | QuestionTool.CancelledError

// User declines dive under the leaves' blanket `mapError` as defects (the deliberate
// tunnel entered in Permission.assert and the question tool), so a user's "no" can
// never become model-facing tool output. They resurface as typed failures exactly once,
// here at the seam the runner executes through.
const declineDefect = (cause: Cause.Cause<Tool.Error>) => {
  const decline = cause.reasons.flatMap((reason) =>
    Cause.isDieReason(reason) &&
    (reason.defect instanceof Permission.DeclinedError || reason.defect instanceof QuestionTool.CancelledError)
      ? [reason.defect]
      : [],
  )[0]
  return decline ? Result.succeed(decline) : Result.fail(cause)
}

export interface Prepared {
  readonly request: LLMRequest
  readonly options: StreamOptions
  /**
   * One request-scoped execution operation. Unknown and hook-removed calls
   * fail individually through the same seam.
   */
  readonly executeTool: (
    input: Parameters<Tool.Snapshot["execute"]>[0],
  ) => Effect.Effect<Tool.NormalizedResult, ExecuteError>
}

interface PrepareInput {
  readonly scope: {
    readonly session: SessionSchema.Info
    readonly agentID: Agent.ID
    /** Agent whose context an auxiliary request reuses, without changing its request-hook identity. */
    readonly contextAgentID?: Agent.ID
    readonly model: SessionRunnerModel.Resolved
    readonly permissions?: Agent.Info["permissions"]
    /** Omitted for requests that carry no tool definitions, such as titles. */
    readonly tools?: Tool.Snapshot
  }
  readonly transcript: {
    readonly system: Array<SystemPart>
    readonly messages: Array<Message>
  }
  readonly toolChoice?: LLM.RequestInput["toolChoice"]
  /** Native automatic compaction threshold selected by the Session runner. */
  readonly compactThreshold?: number
  /** Future protected-context producers append this final system part for ordinary Agent requests. */
  readonly protectedSystem?: SystemPart
  /** Auxiliary native requests omit the future protected system suffix but retain ordinary context hooks. */
  readonly includeSessionRules?: boolean
  /**
   * Session context hooks shape the agent conversation. Standalone requests
   * such as titles opt out; compaction reuses already selected Session context.
   */
  readonly contextHooks?: false
  /** Stateful Session WebSocket channels require an explicit durable-runner opt-in. */
  readonly webSocket?: "session"
}

export const baseTranscript = (input: {
  readonly agent: Agent.Info
  readonly model: SessionRunnerModel.Resolved
  readonly tools: Tool.Snapshot
  readonly initial: string
  readonly messages: ReadonlyArray<SessionMessage.Info>
}) => {
  const providerMetadataKey = input.model.model.route.providerMetadataKey ?? input.model.model.provider
  return {
    providerMetadataKey,
    system: [
      input.agent.system
        ? input.agent.system
        : SessionSystemPrompt.make(input.tools.definitions.map((tool) => tool.name)),
      input.initial,
    ]
      .filter((part) => part.length > 0)
      .map(SystemPart.make),
    messages: toLLMMessages(input.messages, input.model.ref, providerMetadataKey, {
      toolResultPruneMarker: TOOL_RESULT_PRUNE_MARKER,
    }),
  }
}

const mimeToModality = (mime: string) => {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
}

const unsupportedMedia = (mime: string, name: string | undefined, capabilities: Model.Capabilities) => {
  const modality = mimeToModality(mime)
  if (!modality || capabilities.input.some((item) => item.startsWith(modality))) return
  return {
    type: "text" as const,
    text: `ERROR: Cannot read ${name ? `"${name}"` : modality} (this model does not support ${modality} input). Inform the user.`,
  }
}

const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")
const imageSize = (data: string | Uint8Array) =>
  typeof data === "string" ? Buffer.byteLength(data) : Math.ceil(data.byteLength / 3) * 4

const normalizeUnsupportedParts = (messages: LLMRequest["messages"], capabilities: Model.Capabilities) => {
  let result: Message[] | undefined
  let imageBytes = 0
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]
    if (!message) continue
    let content: Array<(typeof message.content)[number]> | undefined
    for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
      const part = message.content[partIndex]
      if (!part) continue
      if (part.type === "media") {
        const replacement = unsupportedMedia(part.mediaType, part.filename, capabilities)
        if (replacement) {
          content ??= [...message.content]
          content[partIndex] = replacement
          continue
        }
        if (isImage(part.mediaType)) imageBytes += imageSize(part.data)
        continue
      }
      if (part.type !== "tool-result" || part.result.type !== "content") continue
      let value: Content[] | undefined
      for (let itemIndex = 0; itemIndex < part.result.value.length; itemIndex++) {
        const item: Content | undefined = part.result.value[itemIndex]
        if (!item || item.type !== "file") continue
        const replacement = unsupportedMedia(item.mime, item.name, capabilities)
        if (replacement) {
          value ??= [...part.result.value]
          value[itemIndex] = replacement
          continue
        }
        if (isImage(item.mime)) imageBytes += Buffer.byteLength(item.uri)
      }
      if (!value) continue
      content ??= [...message.content]
      content[partIndex] = { ...part, result: { ...part.result, value } }
    }
    if (!content) continue
    result ??= [...messages]
    result[messageIndex] = Object.assign(Message.make({ ...message, content }), { content })
  }
  return { messages: result ?? messages, imageBytes }
}

export const unsupportedParts = (messages: LLMRequest["messages"], capabilities: Model.Capabilities) =>
  messages.map((message) =>
    Message.make({
      ...message,
      content: message.content.map((part) => {
        if (part.type === "media") {
          return unsupportedMedia(part.mediaType, part.filename, capabilities) ?? part
        }
        if (part.type !== "tool-result" || part.result.type !== "content") return part
        return {
          ...part,
          result: {
            ...part.result,
            value: part.result.value.map((item: Content) => {
              if (item.type !== "file") return item
              return unsupportedMedia(item.mime, item.name, capabilities) ?? item
            }),
          },
        }
      }),
    }),
  )

const countImageBytes = (messages: LLMRequest["messages"]) =>
  messages.reduce(
    (total, message) =>
      total +
      message.content.reduce((sum, part) => {
        if (part.type === "media" && isImage(part.mediaType)) return sum + imageSize(part.data)
        if (part.type !== "tool-result" || part.result.type !== "content") return sum
        return (
          sum +
          part.result.value.reduce(
            (bytes: number, item: Content) =>
              bytes + (item.type === "file" && isImage(item.mime) ? Buffer.byteLength(item.uri) : 0),
            0,
          )
        )
      }, 0),
    0,
  )

const removeImages = (messages: LLMRequest["messages"], totalImageBytes: number) => {
  let removed = 0
  return messages.map((message) =>
    Message.make({
      ...message,
      content: message.content.map((part) => {
        if (part.type === "media" && isImage(part.mediaType) && totalImageBytes - removed > IMAGE_BYTES_TARGET) {
          removed += imageSize(part.data)
          return Message.text(IMAGE_REMOVED)
        }
        if (part.type !== "tool-result" || part.result.type !== "content") return part
        return {
          ...part,
          result: {
            ...part.result,
            value: part.result.value.map((item: Content) => {
              if (item.type !== "file" || !isImage(item.mime) || totalImageBytes - removed <= IMAGE_BYTES_TARGET)
                return item
              removed += Buffer.byteLength(item.uri)
              return { type: "text" as const, text: IMAGE_REMOVED }
            }),
          },
        }
      }),
    }),
  )
}

export const boundImages = (messages: LLMRequest["messages"]) => {
  const imageBytes = countImageBytes(messages)
  if (imageBytes <= IMAGE_BYTES_TRIGGER) return messages
  return removeImages(messages, imageBytes)
}

const normalizeMessages = (messages: LLMRequest["messages"], capabilities: Model.Capabilities) => {
  const normalized = normalizeUnsupportedParts(messages, capabilities)
  if (normalized.imageBytes <= IMAGE_BYTES_TRIGGER) return normalized.messages
  return removeImages(normalized.messages, normalized.imageBytes)
}

/** The identity a plugin hook sees for one outbound request. */
interface HookScope {
  readonly sessionID: SessionSchema.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
}

const sessionHeaders = (session: Pick<SessionSchema.Info, "id" | "parentID" | "projectID">, app: App.Info) => ({
  "x-session-affinity": session.id,
  "X-Session-Id": session.id,
  ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
  "User-Agent": App.useragent(app),
  "x-opencode-project": session.projectID,
  "x-opencode-session": session.id,
  "x-opencode-client": app.name,
})

const promptCacheKey = (sessionID: SessionSchema.ID) =>
  /^ses_[0-9a-f]{64}$/.test(sessionID) ? sessionID.slice(4) : sessionID

// Lets session.model.request hooks rewrite the base URL and headers before dispatch.
const applyModelHooks = (hooks: PluginHooks.Interface, scope: HookScope, request: LLMRequest) =>
  Effect.gen(function* () {
    const currentBaseURL = request.model.route.endpoint.baseURL
    const event = yield* hooks.trigger("session", "model.request", {
      ...scope,
      baseURL: typeof currentBaseURL === "string" ? currentBaseURL : undefined,
      headers: { ...request.http?.headers },
    })
    const route =
      event.baseURL !== undefined && event.baseURL !== currentBaseURL
        ? request.model.route.with({ endpoint: { baseURL: event.baseURL } })
        : request.model.route
    return LLMRequest.update(request, {
      model: route === request.model.route ? request.model : LanguageModel.update(request.model, { route }),
      http: new HttpOptions({
        body: request.http?.body,
        headers: Object.keys(event.headers).length === 0 ? undefined : event.headers,
        query: request.http?.query,
      }),
    })
  })

// Exposes each outbound HTTP exchange to session.http.request/response hooks
// through web-standard Request/Response values.
const httpMiddleware =
  (hooks: PluginHooks.Interface, scope: HookScope): NonNullable<StreamOptions["http"]> =>
  (request, handler) =>
    Effect.gen(function* () {
      const before = yield* hooks.trigger("session", "http.request", {
        ...scope,
        request: yield* HttpClientRequest.toWeb(request),
      })
      let sent = HttpClientRequest.fromWeb(before.request)
      if (before.request.body)
        sent = HttpClientRequest.bodyUint8Array(
          sent,
          new Uint8Array(yield* Effect.promise(() => before.request.clone().arrayBuffer())),
          before.request.headers.get("content-type") ?? undefined,
        )
      const response = yield* handler(sent)
      const after = yield* hooks.trigger("session", "http.response", {
        ...scope,
        request: before.request,
        response: new Response(
          [204, 205, 304].includes(response.status) ? null : yield* Stream.toReadableStreamEffect(response.stream),
          { status: response.status, headers: response.headers },
        ),
      })
      return HttpClientResponse.fromWeb(sent, after.response)
    }).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))))

/**
 * Builds an outbound model request and captures the tool-call capability that
 * must remain paired with it. It does not execute the request or mutate
 * Session state.
 */
export interface Interface {
  /** Builds one outbound model request and its matching tool-call capability. */
  readonly prepare: (input: PrepareInput) => Effect.Effect<Prepared>
}

/** Location-scoped outbound model-request preparation. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelRequest") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const transport = yield* SessionModelTransport.Service
    const app = yield* App.Metadata
    const prepare = Effect.fn("SessionModelRequest.prepare")(function* (input: PrepareInput) {
      // Direct request-preparation consumers intentionally omit Config; pruning is opt-in there.
      const config = yield* Effect.serviceOption(CoreConfig.Service)
      const session = input.scope.session
      const resolved = input.scope.model
      const model = resolved.model
      const tools = input.scope.tools ?? {
        definitions: [],
        execute: () => new Tool.Error({ message: "Tools are not available for this request" }),
      }
      const registry = new Map(tools.definitions.map((tool) => [tool.name, tool]))
      // The definition objects we hand to hooks, mapped back to their tools. Hooks rename a
      // tool by moving its definition to a new key; recognizing the object recovers the tool.
      const given = new Map(
        tools.definitions.map(
          (tool) => [{ description: tool.description, input: { ...tool.inputSchema } }, tool] as const,
        ),
      )
      // Hooks mutate this record in place: edit descriptions and schemas, rename, or remove.
      const definitions = Object.fromEntries(Array.from(given, ([definition, tool]) => [tool.name, definition]))
      const context: PluginHooks.Domains["session"]["context"] = {
        sessionID: session.id,
        agent: input.scope.contextAgentID ?? input.scope.agentID,
        model: resolved.ref,
        // Hooks own this request-local shape; auxiliary preparation must not inherit their prior mutations.
        system: [...input.transcript.system],
        messages: [...input.transcript.messages],
        tools: definitions,
        generation: {},
        providerOptions: {},
      }
      if (input.contextHooks !== false) yield* hooks.trigger("session", "context", context)
      const system =
        input.includeSessionRules === false || input.protectedSystem === undefined
          ? context.system
          : [...context.system, input.protectedSystem]
      // Match each surviving entry back to its tool, by recognizing a moved definition or
      // by key. Identity wins so a definition moved onto another tool's name still executes
      // the tool it describes. Entries matching neither were invented by a hook and dropped.
      // `tool.name` stays canonical so execution can translate renamed calls back.
      const hooked = new Map(
        Object.entries(context.tools).flatMap(([name, definition]) => {
          const tool = given.get(definition) ?? registry.get(name)
          if (!tool) return []
          return [[name, { ...tool, description: definition.description, inputSchema: definition.input }] as const]
        }),
      )
      const nativeOpenAIResponses = OpenAIResponses.supportsCompaction(model)
      const localWebSearch = nativeOpenAIResponses
        ? Array.from(hooked).find(([, tool]) => tool.name === "websearch")
        : undefined
      if (localWebSearch !== undefined) hooked.delete(localWebSearch[0])
      const hostedWebSearch =
        localWebSearch !== undefined &&
        input.scope.permissions !== undefined &&
        Permission.evaluate("websearch", "*", input.scope.permissions).effect === "allow"
          ? openAIWebSearch()
          : undefined
      const providerOptions = {
        ...context.providerOptions,
        ...(input.compactThreshold === undefined ? {} : { compactThreshold: input.compactThreshold }),
      }
      let request = yield* applyModelHooks(
        hooks,
        { sessionID: session.id, agent: input.scope.agentID, model: resolved.ref },
        LLM.request({
          model,
          http: {
            headers: sessionHeaders(session, app),
          },
          // TODO: Persist cache lineage so nested forks reuse the root session's cache key.
          promptCacheKey: promptCacheKey(session.fork?.sessionID ?? session.id),
          system,
          messages: normalizeMessages(context.messages, resolved.capabilities),
          tools: [
            ...Array.from(hooked, ([name, tool]) => ({ ...tool, name })),
            ...(hostedWebSearch === undefined ? [] : [hostedWebSearch]),
          ],
          toolChoice: input.toolChoice,
          generation: Object.keys(context.generation).length === 0 ? undefined : context.generation,
          providerOptions: Object.keys(providerOptions).length === 0 ? undefined : providerOptions,
        }),
      )
      const messages =
        pruneToolResults(Option.isSome(config) ? yield* config.value.entries() : []) &&
        shouldPruneToolResults(promptTokenEstimate(request), promptLimit(resolved.limit), input.compactThreshold)
          ? projectLargeToolResults(request.messages, TOOL_RESULT_PRUNE_MARKER)
          : stripToolResultPruneMetadata(request.messages, TOOL_RESULT_PRUNE_MARKER)
      request = LLMRequest.update(request, { messages })
      const hasHttpHooks =
        (yield* hooks.has("session", "http.request", resolved.ref.providerID)) ||
        (yield* hooks.has("session", "http.response", resolved.ref.providerID))
      const webSocket =
        resolved.capabilities.responsesWebsockets === true
          ? yield* Config.boolean(responsesWebSocketFlag(resolved.ref.providerID)).pipe(
              Config.withDefault(false),
              Effect.orDie,
            )
          : false
      const http = hasHttpHooks
        ? httpMiddleware(hooks, {
            sessionID: session.id,
            agent: input.scope.agentID,
            model: resolved.ref,
          })
        : undefined
      const options: StreamOptions = {
        ...(http ? { http } : {}),
        ...(input.webSocket === "session" && webSocket && !hasHttpHooks
          ? { webSocket: transport.bind(session.id) }
          : {}),
      }
      const executeTool: Prepared["executeTool"] = (input) =>
        tools
          .execute({ ...input, definitions: hooked })
          .pipe(Effect.catchCauseFilter(declineDefect, (decline) => Effect.fail(decline)))
      return {
        request,
        options,
        executeTool,
      }
    })

    return Service.of({ prepare })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, SessionModelTransport.node, App.node],
})
