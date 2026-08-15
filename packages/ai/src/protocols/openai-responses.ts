import { Effect, Encoding, Schema, Stream } from "effect"
import type { HttpClientResponse } from "effect/unstable/http"
import { Route, resolveRequest, type StreamOptions } from "../route/client.js"
import { Auth } from "../route/auth.js"
import { Endpoint } from "../route/endpoint.js"
import { RequestExecutor } from "../route/executor.js"
import { Protocol } from "../route/protocol.js"
import { HttpTransport, WebSocketTransport } from "../route/transport/index.js"
import {
  AIError,
  HttpOptions,
  InvalidProviderOutputReason,
  LLMEvent,
  LLMRequest,
  mergeJsonRecords,
  mergeProviderOptions,
  type JsonSchema,
  type LanguageModel,
  type ToolDefinition,
} from "../schema/index.js"
import { OpenResponses } from "./open-responses.js"
import { optionalArray, ProviderShared } from "./shared.js"
import { Lifecycle } from "./utils/lifecycle.js"
import { OpenAIImage } from "./utils/openai-image.js"
import { OpenAICompaction } from "./utils/openai-compaction.js"
import { OpenResponsesOptions } from "./utils/open-responses-options.js"
import { ToolSchemaProjection } from "./utils/tool-schema.js"

const ADAPTER = "openai-responses"
const NAME = "OpenAI Responses"
// OpenAI rejects the request before context management when this wire-level
// array is larger, so surface a typed overflow while Session can still compact.
const INPUT_ITEM_LIMIT = 16_384
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = OpenResponses.PATH
export const COMPACT_PATH = "/responses/compact"

const NATIVE_ROUTE_IDS = new Set([ADAPTER, `${ADAPTER}-websocket`])
const COMPACT_SERVICE_TIERS = new Set(["auto", "default", "fast", "flex", "priority"])

const OpenAIResponsesImageGenerationTool = Schema.Struct({
  type: Schema.tag("image_generation"),
  action: Schema.optional(Schema.Literals(["auto", "generate", "edit"])),
  background: Schema.optional(Schema.Literals(["auto", "opaque", "transparent"])),
  input_fidelity: Schema.optional(Schema.Literals(["low", "high"])),
  output_compression: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  output_format: Schema.optional(Schema.Literals(["png", "jpeg", "webp"])),
  partial_images: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  quality: Schema.optional(Schema.Literals(["auto", "low", "medium", "high"])),
  size: Schema.optional(OpenAIImage.Size),
})

const OpenAIResponsesWebSearchTool = Schema.Struct({
  type: Schema.tag("web_search"),
  filters: Schema.optional(
    Schema.Struct({
      allowed_domains: Schema.Array(Schema.String),
    }),
  ),
  search_context_size: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  user_location: Schema.optional(
    Schema.Struct({
      type: Schema.tag("approximate"),
      city: Schema.optional(Schema.String),
      country: Schema.optional(Schema.String),
      region: Schema.optional(Schema.String),
      timezone: Schema.optional(Schema.String),
    }),
  ),
})

const OpenAIResponsesTools = Schema.Union([
  OpenResponses.Tool,
  OpenAIResponsesImageGenerationTool,
  OpenAIResponsesWebSearchTool,
])

const OpenAIResponsesToolChoice = Schema.Union([
  OpenResponses.ToolChoice,
  Schema.Struct({ type: Schema.tag("image_generation") }),
  Schema.Struct({ type: Schema.tag("web_search") }),
])

const OpenAIResponsesInputItemShape = Schema.Union([
  Schema.Struct({
    role: Schema.tag("assistant"),
    content: Schema.Array(Schema.Struct({ type: Schema.tag("output_text"), text: Schema.String })),
    phase: Schema.optionalKey(Schema.NullOr(OpenResponses.MessagePhase)),
  }),
  OpenResponses.StreamItem,
  OpenResponses.InputItem,
])
type OpenAIResponsesInputItem = Schema.Schema.Type<typeof OpenAIResponsesInputItemShape>
const isOpenAIResponsesInputItem = Schema.is(OpenAIResponsesInputItemShape)
const isJson = Schema.is(Schema.Json)
// Validate input items without projecting provider-owned checkpoint fields.
const OpenAIResponsesInputItem = Schema.declare<OpenAIResponsesInputItem>(
  (value): value is OpenAIResponsesInputItem => isOpenAIResponsesInputItem(value) && isJson(value),
  { expected: "OpenAI Responses JSON input item" },
)

const OpenAIResponsesCoreFields = {
  ...OpenResponses.coreFields,
  input: Schema.Array(OpenAIResponsesInputItem),
  tools: optionalArray(OpenAIResponsesTools),
  tool_choice: Schema.optional(OpenAIResponsesToolChoice),
}

const OpenAIResponsesBody = Schema.Struct({
  ...OpenAIResponsesCoreFields,
  stream: Schema.Literal(true),
})
export type OpenAIResponsesBody = Schema.Schema.Type<typeof OpenAIResponsesBody>

const OpenAIResponsesCompactBody = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(OpenAIResponsesInputItem),
  instructions: Schema.optional(Schema.String),
  prompt_cache_key: Schema.optional(Schema.String),
  service_tier: Schema.optional(Schema.Literals(["auto", "default", "fast", "flex", "priority"])),
})
export type OpenAIResponsesCompactBody = Schema.Schema.Type<typeof OpenAIResponsesCompactBody>

const OpenAIResponsesCompactResponse = Schema.StructWithRest(
  Schema.Struct({
    object: Schema.tag("response.compaction"),
    output: Schema.Array(Schema.Json),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

const OpenAIResponsesWebSocketMessage = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("response.create"),
    ...OpenAIResponsesCoreFields,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
type OpenAIResponsesWebSocketMessage = Schema.Schema.Type<typeof OpenAIResponsesWebSocketMessage>
const encodeWebSocketMessage = Schema.encodeSync(Schema.fromJsonString(OpenAIResponsesWebSocketMessage))

const extension = {
  id: ADAPTER,
  name: NAME,
  messagePhase: (value: unknown) => (value === null ? null : undefined),
  lowerMedia: ({ part, media, request }) => {
    if (request.model.provider !== "xai" || media.mime !== "application/pdf") return undefined
    return {
      type: "input_file",
      filename: part.filename ?? "document.pdf",
      file_data: media.base64,
      mime_type: media.mime,
    }
  },
  lowerProviderExecutedTool: ({ part, providerMetadataKey }) => {
    const metadata = part.providerMetadata?.[providerMetadataKey]
    if (!ProviderShared.isRecord(metadata) || !Schema.is(OpenResponses.StreamItem)(metadata.hostedItem))
      return undefined
    if (!isHostedToolItem(metadata.hostedItem) || metadata.hostedItem.id !== part.id) return undefined
    return structuredClone(metadata.hostedItem)
  },
  lowerUserMessage: ({ message }) => {
    if (message.content.length !== 1 || message.content[0].type !== "text") return undefined
    const metadata = message.content[0].providerMetadata?.opencode
    if (!ProviderShared.isRecord(metadata) || !ProviderShared.isRecord(metadata.remoteCompaction)) return undefined
    const output = metadata.remoteCompaction.output
    if (!OpenAICompaction.isOutput(output)) return undefined
    return structuredClone(output)
  },
} satisfies OpenResponses.Extension

const nativeOpenAIToolInput = (tool: ToolDefinition) => {
  const native = tool.native?.openai
  return ProviderShared.isRecord(native) ? native : undefined
}

const nativeImageToolInput = (tool: ToolDefinition) => {
  const native = nativeOpenAIToolInput(tool)
  return native?.type === "image_generation" ? native : undefined
}

const nativeImageTool = (tool: ToolDefinition) => {
  const native = nativeImageToolInput(tool)
  return Schema.is(OpenAIResponsesImageGenerationTool)(native) ? native : undefined
}

const nativeWebSearchToolInput = (tool: ToolDefinition) => {
  const native = nativeOpenAIToolInput(tool)
  return native?.type === "web_search" ? native : undefined
}

const nativeWebSearchTool = (tool: ToolDefinition) => {
  const native = nativeWebSearchToolInput(tool)
  return Schema.is(OpenAIResponsesWebSearchTool)(native) ? native : undefined
}

const lowerTool = Effect.fn("OpenAIResponses.lowerTool")(function* (tool: ToolDefinition, inputSchema: JsonSchema) {
  const image = nativeImageToolInput(tool)
  if (image !== undefined) {
    if (Schema.is(OpenAIResponsesImageGenerationTool)(image)) return image
    return yield* ProviderShared.invalidRequest("OpenAI Responses image generation tool options are invalid")
  }
  const webSearch = nativeWebSearchToolInput(tool)
  if (webSearch !== undefined) {
    if (Schema.is(OpenAIResponsesWebSearchTool)(webSearch)) return webSearch
    return yield* ProviderShared.invalidRequest("OpenAI Responses web search tool options are invalid")
  }
  return yield* OpenResponses.lowerTool(NAME, tool, inputSchema)
})

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>, tools: ReadonlyArray<ToolDefinition>) =>
  ProviderShared.matchToolChoice(NAME, toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (name) => {
      const selected = tools.find((tool) => tool.name === name)
      if (selected && nativeImageTool(selected) !== undefined) return { type: "image_generation" } as const
      if (selected && nativeWebSearchTool(selected) !== undefined) return { type: "web_search" } as const
      return { type: "function" as const, name }
    },
  })

const fromRequest = Effect.fn("OpenAIResponses.fromRequest")(function* (request: LLMRequest) {
  const compactionTrigger = OpenResponsesOptions.compactionTrigger(request)
  const body = yield* OpenResponses.fromRequestWithExtension(
    LLMRequest.update(request, { tools: [], toolChoice: undefined }),
    extension,
  )
  const input = compactionTrigger ? [...body.input, { type: "compaction_trigger" as const }] : body.input
  if (input.length > INPUT_ITEM_LIMIT)
    return yield* ProviderShared.invalidRequest(
      `OpenAI Responses input contains ${input.length} items; maximum is ${INPUT_ITEM_LIMIT}`,
      { parameter: "input", classification: "context-overflow" },
    )
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  return {
    ...body,
    input,
    tools:
      compactionTrigger || request.tools.length === 0
        ? undefined
        : yield* Effect.forEach(request.tools, (tool) =>
            lowerTool(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility)),
          ),
    tool_choice:
      !compactionTrigger && request.toolChoice ? yield* lowerToolChoice(request.toolChoice, request.tools) : undefined,
  } satisfies OpenAIResponsesBody
})

const decodeCompactBody = ProviderShared.validateWith(Schema.decodeUnknownEffect(OpenAIResponsesCompactBody))

const compactBody = Effect.fn("OpenAIResponses.compactBody")(function* (request: LLMRequest) {
  const lowered = yield* OpenResponses.fromRequestWithExtension(
    LLMRequest.update(request, { tools: [], toolChoice: undefined }),
    extension,
  )
  const overlaid = mergeJsonRecords(lowered, request.http?.body) ?? lowered
  return yield* decodeCompactBody({
    model: overlaid.model,
    input: overlaid.input,
    instructions: overlaid.instructions,
    prompt_cache_key: overlaid.prompt_cache_key,
    service_tier:
      typeof overlaid.service_tier === "string" && COMPACT_SERVICE_TIERS.has(overlaid.service_tier)
        ? overlaid.service_tier
        : undefined,
  })
})

const invalidCompactOutput = (message: string, raw?: string) =>
  new AIError({
    module: ADAPTER,
    method: "compact",
    reason: new InvalidProviderOutputReason({ route: ADAPTER, message, raw }),
  })

const parseCompactResponse = Effect.fn("OpenAIResponses.parseCompactResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const payload = yield* response.json.pipe(
    Effect.mapError(() => invalidCompactOutput("Failed to read the OpenAI Responses compact response")),
  )
  const decoded = yield* Schema.decodeUnknownEffect(OpenAIResponsesCompactResponse)(payload).pipe(
    Effect.mapError(() =>
      invalidCompactOutput("OpenAI Responses returned an invalid compact response", ProviderShared.encodeJson(payload)),
    ),
  )
  if (!OpenAICompaction.isOutput(decoded.output))
    return yield* invalidCompactOutput(
      "OpenAI Responses compact output did not contain a replayable compaction item",
      ProviderShared.encodeJson(payload),
    )
  return structuredClone(decoded.output)
})

/** Legacy low-level JSON endpoint retained for compatibility. Core manual compaction uses compactV2. */
export const compact = Effect.fn("OpenAIResponses.compact")(function* (
  source: LLMRequest,
  execute: RequestExecutor.Interface["execute"],
  options?: StreamOptions,
) {
  const request = resolveRequest(source)
  if (!supportsCompaction(request.model))
    return yield* ProviderShared.invalidRequest(
      `OpenAI Responses compact requires the native OpenAI Responses route; received ${request.model.route.id}`,
    )
  const body = yield* compactBody(request)
  const transportRequest = LLMRequest.update(request, {
    http:
      request.http?.headers === undefined && request.http?.query === undefined
        ? undefined
        : new HttpOptions({ headers: request.http.headers, query: request.http.query }),
  })
  const parts = yield* HttpTransport.jsonRequestParts({
    body,
    request: transportRequest,
    endpoint: Endpoint.path<OpenAIResponsesCompactBody>(COMPACT_PATH, {
      baseURL: request.model.route.endpoint.baseURL,
      query: request.model.route.endpoint.query,
    }),
    auth: request.model.route.auth,
    encodeBody: ProviderShared.encodeJson,
    middleware: options?.http,
  })
  const response = yield* execute(
    ProviderShared.jsonPost({ url: parts.url, body: parts.bodyText, headers: parts.headers }),
    options?.http,
  )
  return yield* parseCompactResponse(response)
})

const COMPACTION_BODY_KEYS = new Set([
  "context_management",
  "input",
  "parallel_tool_calls",
  "previous_response_id",
  "store",
  "stream",
  "tool_choice",
  "tools",
])

const withoutCompactionBodyOverrides = (body: unknown) => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined
  return Object.fromEntries(Object.entries(body).filter(([key]) => !COMPACTION_BODY_KEYS.has(key)))
}

const withCompactionTrigger = (request: LLMRequest) => {
  const provider = request.model.route.providerMetadataKey ?? "openresponses"
  return LLMRequest.update(request, {
    tools: [],
    toolChoice: undefined,
    http: request.http
      ? new HttpOptions({
          body: withoutCompactionBodyOverrides(request.http.body),
          headers: request.http.headers,
          query: request.http.query,
        })
      : undefined,
    providerOptions: mergeProviderOptions(request.providerOptions, {
      [provider]: { store: false },
      "opencode-internal": { responsesCompactionTrigger: true },
    }),
  })
}

type StreamRequest = (request: LLMRequest, options?: StreamOptions) => Stream.Stream<LLMEvent, AIError>

type CompactionStreamState = {
  readonly checkpoints: ReadonlyArray<{ readonly reset: boolean; readonly item: unknown }>
  readonly unexpected?: string
  readonly providerError?: {
    readonly message: string
    readonly classification?: "context-overflow" | "payload-too-large"
  }
}

const emptyCompactionStreamState = (): CompactionStreamState => ({ checkpoints: [] })

/** Streams a Responses V2 compaction trigger and accepts exactly one encrypted checkpoint. */
export const compactV2 = Effect.fn("OpenAIResponses.compactV2")(function* (
  source: LLMRequest,
  stream: StreamRequest,
  options?: StreamOptions,
) {
  const request = resolveRequest(source)
  if (!supportsCompaction(request.model))
    return yield* ProviderShared.invalidRequest(
      `OpenAI Responses V2 compaction requires the native OpenAI Responses route; received ${request.model.route.id}`,
    )

  const result = yield* stream(withCompactionTrigger(request), options).pipe(
    Stream.runFold(emptyCompactionStreamState, (state, event) => {
      if (event.type === "provider-checkpoint") {
        return { ...state, checkpoints: [...state.checkpoints, { reset: event.reset, item: event.item }] }
      }
      if (event.type === "provider-error") {
        return {
          ...state,
          providerError: { message: event.message, classification: event.classification },
        }
      }
      if (
        event.type === "provider-compaction-start" ||
        event.type === "step-start" ||
        event.type === "step-finish" ||
        event.type === "finish"
      )
        return state
      return { ...state, unexpected: state.unexpected ?? event.type }
    }),
  )

  if (result.providerError)
    return yield* ProviderShared.invalidRequest(result.providerError.message, {
      classification: result.providerError.classification,
    })
  if (result.unexpected)
    return yield* Effect.fail(
      invalidCompactOutput(`OpenAI Responses V2 compaction emitted unexpected ${result.unexpected} output`),
    )
  if (result.checkpoints.length !== 1)
    return yield* Effect.fail(
      invalidCompactOutput(
        `OpenAI Responses V2 compaction returned ${result.checkpoints.length} checkpoint items instead of exactly one`,
      ),
    )

  const checkpoint = result.checkpoints[0]
  if (!checkpoint.reset || !OpenAICompaction.isCompactionItem(checkpoint.item) || checkpoint.item.type !== "compaction")
    return yield* Effect.fail(
      invalidCompactOutput("OpenAI Responses V2 compaction did not return one replayable compaction item"),
    )

  return [structuredClone(checkpoint.item)]
})

type HostedToolData = OpenResponses.StreamItem & {
  readonly id: string
  readonly status?: string
  readonly action?: unknown
  readonly queries?: unknown
  readonly results?: unknown
  readonly code?: string
  readonly container_id?: string
  readonly outputs?: unknown
  readonly server_label?: string
  readonly output?: unknown
  readonly result?: string
  readonly output_format?: "png" | "jpeg" | "webp"
  readonly error?: unknown
}

const HOSTED_TOOLS = {
  web_search_call: { name: "web_search", input: (item) => item.action ?? {} },
  web_search_preview_call: { name: "web_search_preview", input: (item) => item.action ?? {} },
  file_search_call: { name: "file_search", input: (item) => ({ queries: item.queries ?? [] }) },
  code_interpreter_call: {
    name: "code_interpreter",
    input: (item) => ({ code: item.code, container_id: item.container_id }),
  },
  computer_use_call: { name: "computer_use", input: (item) => item.action ?? {} },
  image_generation_call: { name: "image_generation", input: () => ({}) },
  mcp_call: {
    name: "mcp",
    input: (item) => ({ server_label: item.server_label, name: item.name, arguments: item.arguments }),
  },
  local_shell_call: { name: "local_shell", input: (item) => item.action ?? {} },
} as const satisfies Record<string, { readonly name: string; readonly input: (item: HostedToolData) => unknown }>

type HostedToolType = keyof typeof HOSTED_TOOLS
type HostedToolItem = HostedToolData & { readonly type: HostedToolType }

function isHostedToolItem(item: OpenResponses.StreamItem): item is HostedToolItem {
  return item.type in HOSTED_TOOLS && typeof item.id === "string" && item.id.length > 0
}

const hostedToolResult = Effect.fn("OpenAIResponses.hostedToolResult")(function* (item: HostedToolItem) {
  const isError = item.error !== undefined && item.error !== null
  if (item.type === "image_generation_call" && item.result) {
    yield* Effect.fromResult(Encoding.decodeBase64(item.result)).pipe(
      Effect.mapError(() => ProviderShared.eventError(ADAPTER, "OpenAI Responses returned invalid image base64")),
    )
    const format = item.output_format ?? "png"
    return {
      type: "content" as const,
      value: [
        {
          type: "file" as const,
          uri: `data:image/${format};base64,${item.result}`,
          mime: `image/${format}`,
        },
      ],
    }
  }
  return isError ? { type: "error" as const, value: item.error } : { type: "json" as const, value: item }
})

const onHostedToolDone = Effect.fn("OpenAIResponses.onHostedToolDone")(function* (
  state: OpenResponses.ParserState,
  item: HostedToolItem,
) {
  const tool = HOSTED_TOOLS[item.type]
  const providerMetadata = OpenResponses.providerMetadata(state, {
    itemId: item.id,
    hostedItem: structuredClone(item),
  })
  const events: LLMEvent[] = []
  const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
  events.push(
    LLMEvent.toolCall({
      id: item.id,
      name: tool.name,
      input: tool.input(item),
      providerExecuted: true,
      providerMetadata,
    }),
    LLMEvent.toolResult({
      id: item.id,
      name: tool.name,
      result: yield* hostedToolResult(item),
      providerExecuted: true,
      providerMetadata,
    }),
  )
  return [{ ...state, lifecycle }, events] satisfies OpenResponses.StepResult
})

const step = (state: OpenResponses.ParserState, event: OpenResponses.Event) => {
  if (event.type === "response.reasoning_text.delta" || event.type === "response.reasoning_summary.delta")
    return event.item_id
      ? Effect.succeed(OpenResponses.onReasoningDelta(state, event, event.item_id))
      : ProviderShared.eventError(ADAPTER, `${event.type} is missing item_id`)
  if (event.type === "response.reasoning_text.done" || event.type === "response.reasoning_summary.done")
    return event.item_id
      ? Effect.succeed(OpenResponses.onReasoningDone(state, event))
      : ProviderShared.eventError(ADAPTER, `${event.type} is missing item_id`)
  if (event.type === "response.output_item.added" && event.item?.type === "compaction") {
    return Effect.succeed([state, [LLMEvent.providerCompactionStart({})]] satisfies OpenResponses.StepResult)
  }
  if (event.type === "response.output_item.done" && event.item) {
    if (!OpenAICompaction.isOutputItem(event.item))
      return ProviderShared.eventError(ADAPTER, "OpenAI Responses checkpoint output item is malformed or redacted")
    const reset = OpenAICompaction.isCompactionItem(event.item)
    const checkpointEvents =
      reset || state.hasCheckpoint
        ? [
            LLMEvent.providerCheckpoint({
              reset,
              item: structuredClone(event.item),
            }),
          ]
        : []
    const checkpointState = reset ? { ...state, hasCheckpoint: true } : state
    const result = isHostedToolItem(event.item)
      ? onHostedToolDone(checkpointState, event.item)
      : OpenResponses.step(checkpointState, event)
    return Effect.map(
      result,
      ([next, events]) => [next, [...checkpointEvents, ...events]] satisfies OpenResponses.StepResult,
    )
  }
  return OpenResponses.step(state, event)
}

export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIResponsesBody,
    from: fromRequest,
  },
  stream: {
    event: OpenResponses.protocol.stream.event,
    initial: (request) => OpenResponses.initial(request, extension),
    step,
    terminal: OpenResponses.terminal,
  },
})

export const supportsCompaction = (model: LanguageModel) =>
  model.route.provider === "openai" && NATIVE_ROUTE_IDS.has(model.route.id) && model.route.body === protocol.body

const endpoint = Endpoint.path<OpenAIResponsesBody>(PATH, { baseURL: DEFAULT_BASE_URL })
const auth = Auth.none

export const httpTransport = HttpTransport.sseJson.with<OpenAIResponsesBody>()

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  providerMetadataKey: "openai",
  protocol,
  endpoint,
  auth,
  transport: httpTransport,
  defaults: { providerOptions: { openai: { store: false } } },
})

const decodeWebSocketMessage = ProviderShared.validateWith(Schema.decodeUnknownEffect(OpenAIResponsesWebSocketMessage))

const webSocketMessage = (body: OpenAIResponsesBody | Record<string, unknown>) =>
  Effect.gen(function* () {
    if (!ProviderShared.isRecord(body))
      return yield* ProviderShared.invalidRequest("OpenAI Responses WebSocket body must be a JSON object")
    const { stream: _stream, ...message } = body
    return yield* decodeWebSocketMessage({ ...message, type: "response.create" })
  })

export const webSocketTransport = WebSocketTransport.jsonTransport.with<
  OpenAIResponsesBody,
  OpenAIResponsesWebSocketMessage
>({
  toMessage: webSocketMessage,
  encodeMessage: encodeWebSocketMessage,
})

export const webSocketRoute = Route.make({
  id: `${ADAPTER}-websocket`,
  provider: "openai",
  providerMetadataKey: "openai",
  protocol,
  endpoint,
  auth,
  transport: webSocketTransport,
  defaults: { providerOptions: { openai: { store: false } } },
})

export * as OpenAIResponses from "./openai-responses.js"
