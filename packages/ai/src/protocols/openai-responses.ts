import { Effect, Encoding, Schema, Stream } from "effect"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import { Route, type StreamOptions } from "../route/client.js"
import type { HttpMiddleware } from "../route/executor.js"
import { Auth } from "../route/auth.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import { HttpTransport } from "../route/transport/index.js"
import {
  AIError,
  HttpOptions,
  InvalidProviderOutputError,
  InvalidRequestError,
  LanguageModel,
  LLMEvent,
  LLMRequest,
  mergeProviderOptions,
  type JsonSchema,
  type ToolDefinition,
} from "../schema/index.js"
import { OpenResponses } from "./open-responses.js"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared.js"
import { OpenAIImage } from "./utils/openai-image.js"
import { OpenAICompaction } from "./utils/openai-compaction.js"
import { ResponsesHostedTools } from "./utils/responses-hosted-tools.js"
import { ToolSchemaProjection } from "./utils/tool-schema.js"
import { OpenResponsesChannel } from "./open-responses-channel.js"

const ADAPTER = "openai-responses"
const NAME = "OpenAI Responses"
const INPUT_ITEM_LIMIT = 16_384
const WEBSOCKET_PROTOCOL_HEADER = "responses_websockets=2026-02-06"
const WEBSOCKET_ROTATE_AFTER_MS = 55 * 60 * 1000
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = OpenResponses.PATH
const COMPACTION_PARSER_STATE = Symbol("OpenAIResponses.compactionParserState")
const COMPACTION_CHECKPOINT_STATE = Symbol("OpenAIResponses.compactionCheckpointState")
const compactionRoutes = new WeakSet<object>()

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

const OpenAIResponsesHostedToolItem = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.tag("computer_call"),
      id: Schema.String,
      status: Schema.optional(Schema.String),
      call_id: Schema.optional(Schema.String),
      action: optionalNull(JsonObject),
      pending_safety_checks: Schema.optional(Schema.Array(JsonObject)),
    }),
    [JsonObject],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.tag("web_search_preview_call"),
      id: Schema.String,
      status: Schema.optional(Schema.String),
      action: optionalNull(JsonObject),
    }),
    [JsonObject],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.tag("image_generation_call"),
      id: Schema.String,
      status: Schema.optional(Schema.String),
      result: optionalNull(Schema.String),
      output_format: Schema.optional(Schema.Literals(["png", "jpeg", "webp"])),
      revised_prompt: optionalNull(Schema.String),
    }),
    [JsonObject],
  ),
])

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

const OpenAIResponsesKnownInputItem = Schema.Union([OpenResponses.InputItem, OpenAIResponsesHostedToolItem])
const OpenAIResponsesInputItemShape = Schema.Union([OpenAIResponsesKnownInputItem, OpenResponses.StreamItem])
type OpenAIResponsesInputItem = Schema.Schema.Type<typeof OpenAIResponsesInputItemShape>
const isOpenAIResponsesKnownInputItem = Schema.is(OpenAIResponsesKnownInputItem)
const isOpenAIResponsesStreamItem = Schema.is(OpenResponses.StreamItem)
const isJson = Schema.is(Schema.Json)
// Provider-owned checkpoint items must remain opaque after their JSON shape is validated.
const OpenAIResponsesInputItem = Schema.declare<OpenAIResponsesInputItem>(
  (value): value is OpenAIResponsesInputItem =>
    isOpenAIResponsesKnownInputItem(value) || (isOpenAIResponsesStreamItem(value) && isJson(value)),
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

const adapter = {
  id: ADAPTER,
  name: NAME,
  restoreHostedToolItem: (item: unknown) => (Schema.is(OpenAIResponsesHostedToolItem)(item) ? item : undefined),
  lowerUserMessage: ({ message }) => {
    if (message.content.length !== 1 || message.content[0].type !== "text") return undefined
    const metadata = message.content[0].providerMetadata?.opencode
    if (!ProviderShared.isRecord(metadata) || !ProviderShared.isRecord(metadata.remoteCompaction)) return undefined
    const output = metadata.remoteCompaction.output
    return OpenAICompaction.isOutput(output) ? structuredClone(output) : undefined
  },
} satisfies OpenResponses.ProviderAdapter

const nativeImageToolInput = (tool: ToolDefinition) => {
  const native = tool.native?.openai
  return ProviderShared.isRecord(native) && native.type === "image_generation" ? native : undefined
}

const nativeImageTool = (tool: ToolDefinition) => {
  const native = nativeImageToolInput(tool)
  return Schema.is(OpenAIResponsesImageGenerationTool)(native) ? native : undefined
}

const nativeWebSearchToolInput = (tool: ToolDefinition) => {
  const native = tool.native?.openai
  return ProviderShared.isRecord(native) && native.type === "web_search" ? native : undefined
}

const nativeWebSearchTool = (tool: ToolDefinition) => {
  const native = nativeWebSearchToolInput(tool)
  return Schema.is(OpenAIResponsesWebSearchTool)(native) ? native : undefined
}

const lowerTool = Effect.fn("OpenAIResponses.lowerTool")(function* (tool: ToolDefinition, inputSchema: JsonSchema) {
  const native = nativeImageToolInput(tool)
  if (native !== undefined) {
    if (Schema.is(OpenAIResponsesImageGenerationTool)(native)) return native
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

const decodeBody = ProviderShared.validateWith(Schema.decodeUnknownEffect(OpenAIResponsesBody))

const fromRequest = Effect.fn("OpenAIResponses.fromRequest")(function* (request: LLMRequest) {
  const compactionTrigger = compactionRoutes.has(request.model.route)
  const body = {
    ...(yield* OpenResponses.lowerConversation(request, adapter)),
    ...OpenResponses.lowerGeneration(request),
  }
  const input = compactionTrigger ? [...body.input, { type: "compaction_trigger" as const }] : body.input
  if (input.length > INPUT_ITEM_LIMIT)
    return yield* new AIError({
      reason: new InvalidRequestError({
        message: `OpenAI Responses input contains ${input.length} items; maximum is ${INPUT_ITEM_LIMIT}`,
        parameter: "input",
        classification: "context-overflow",
      }),
    })
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  const parallelToolCalls = OpenResponses.resolveParallelToolCalls(request)
  return yield* decodeBody({
    ...body,
    input,
    context_management: compactionTrigger ? undefined : body.context_management,
    ...(compactionTrigger || parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }),
    tools:
      compactionTrigger || request.tools.length === 0
        ? undefined
        : yield* Effect.forEach(request.tools, (tool) =>
            lowerTool(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility)),
          ),
    tool_choice:
      compactionTrigger || request.tools.length === 0
        ? undefined
        : (OpenResponses.allowedToolChoice(request) ??
          (request.toolChoice ? yield* lowerToolChoice(request.toolChoice, request.tools) : undefined)),
  })
})

const COMPACTION_BODY_KEYS = new Set([
  "context_management",
  "input",
  "parallel_tool_calls",
  "previous_response_id",
  "previous_response",
  "continuation",
  "store",
  "stream",
  "tool_choice",
  "tools",
])
const COMPACTION_PROVIDER_OPTION_KEYS = new Set([
  "allowedTools",
  "compactThreshold",
  "maxToolCalls",
  "parallelToolCalls",
])

const withoutCompactionBodyOverrides = (body: Record<string, unknown> | undefined) => {
  if (body === undefined) return undefined
  const result = Object.fromEntries(Object.entries(body).filter(([key]) => !COMPACTION_BODY_KEYS.has(key)))
  return Object.keys(result).length === 0 ? undefined : result
}

const withoutCompactionProviderOptions = (options: Record<string, unknown> | undefined) => {
  if (options === undefined) return undefined
  const result = Object.fromEntries(
    Object.entries(options).filter(([key]) => !COMPACTION_PROVIDER_OPTION_KEYS.has(key)),
  )
  return Object.keys(result).length === 0 ? undefined : result
}

const withoutCompactionHttp = (http: HttpOptions | undefined) => {
  if (http === undefined) return undefined
  const body = withoutCompactionBodyOverrides(http.body)
  if (body === undefined && http.headers === undefined && http.query === undefined) return undefined
  return new HttpOptions({ body, headers: http.headers, query: http.query })
}

const hostedToolResult = Effect.fn("OpenAIResponses.hostedToolResult")(function* (item: ResponsesHostedTools.Item) {
  const isError = item.error !== undefined && item.error !== null
  if (item.type === "image_generation_call" && item.result) {
    yield* Effect.fromResult(Encoding.decodeBase64(item.result)).pipe(
      Effect.mapError((cause) =>
        ProviderShared.eventError(ADAPTER, "OpenAI Responses returned invalid image base64", undefined, cause),
      ),
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

const HOSTED_TOOLS = {
  web_search_call: { name: "web_search", input: (item) => item.action ?? {} },
  web_search_preview_call: { name: "web_search_preview", input: (item) => item.action ?? {} },
  file_search_call: { name: "file_search", input: (item) => ({ queries: item.queries ?? [] }) },
  code_interpreter_call: {
    name: "code_interpreter",
    input: (item) => ({ code: item.code, container_id: item.container_id }),
  },
  computer_call: { name: "computer_use", input: (item) => item.action ?? {} },
  image_generation_call: { name: "image_generation", input: () => ({}), result: hostedToolResult },
  mcp_call: {
    name: "mcp",
    input: (item) => ({ server_label: item.server_label, name: item.name, arguments: item.arguments }),
  },
} as const satisfies ResponsesHostedTools.Definitions

type ParserState = OpenResponses.ParserState & {
  readonly [COMPACTION_PARSER_STATE]?: boolean
  readonly [COMPACTION_CHECKPOINT_STATE]?: boolean
}

const isCompactionParserState = (state: ParserState) => state[COMPACTION_PARSER_STATE] === true

const stepInternal = (state: ParserState, event: OpenResponses.NormalizedEvent) => {
  if (event.type === "response.reasoning_text.delta") {
    if (event.item_id === undefined) return ProviderShared.eventError(ADAPTER, `${event.type} is missing item_id`)
    if (state.reasoningItems[event.item_id] === undefined)
      return ProviderShared.eventError(ADAPTER, `${event.type} arrived before reasoning item start`)
    return Effect.succeed(OpenResponses.onReasoningDelta(state, event, event.item_id))
  }
  if (
    event.type === "response.output_item.added" &&
    (event.item?.type === "compaction" || event.item?.type === "compaction_summary")
  )
    return Effect.succeed([state, [LLMEvent.providerCompactionStart({})]] satisfies OpenResponses.StepResult)
  if (event.type === "response.output_item.done" && event.item) {
    if (!OpenAICompaction.isOutputItem(event.item))
      return ProviderShared.eventError(ADAPTER, "OpenAI Responses checkpoint output item is malformed or redacted")
    const reset = OpenAICompaction.isCompactionItem(event.item)
    const checkpointed = reset || state[COMPACTION_CHECKPOINT_STATE] === true || isCompactionParserState(state)
    const checkpointEvents = checkpointed
      ? [LLMEvent.providerCheckpoint({ reset, item: structuredClone(event.item) })]
      : []
    const next = reset
      ? ({
          ...state,
          [COMPACTION_CHECKPOINT_STATE]: true,
          completedCompactions: new Set([...state.completedCompactions, event.item.id]),
        } as ParserState)
      : state
    // Native OpenAI compaction remains represented by provider-checkpoint;
    // do not also emit the explicit-route CompactionPart consumed by xAI.
    const result = reset
      ? Effect.succeed([next, []] satisfies OpenResponses.StepResult)
      : ResponsesHostedTools.isItem(event.item, HOSTED_TOOLS)
        ? ResponsesHostedTools.onDone(next, event.item, HOSTED_TOOLS)
        : OpenResponses.step(next, event)
    return Effect.map(
      result,
      ([following, events]) => [following, [...checkpointEvents, ...events]] satisfies OpenResponses.StepResult,
    )
  }
  return OpenResponses.step(state, event)
}

const step = (state: ParserState, input: OpenResponses.Event) => {
  const event = OpenResponses.normalize(state, input)
  return Effect.map(stepInternal(state, event), ([next, events]) => {
    const parserState = isCompactionParserState(state)
      ? ({ ...next, [COMPACTION_PARSER_STATE]: true } as ParserState)
      : next
    return [parserState, events] as const satisfies OpenResponses.StepResult
  })
}

export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIResponsesBody,
    from: fromRequest,
  },
  stream: {
    event: OpenResponses.protocol.stream.event,
    initial: (request) => {
      const state = OpenResponses.initial(request, adapter)
      return compactionRoutes.has(request.model.route)
        ? ({ ...state, [COMPACTION_PARSER_STATE]: true } as ParserState)
        : state
    },
    step,
    terminal: OpenResponses.terminal,
  },
})

const endpoint = Endpoint.path<OpenAIResponsesBody>(PATH, { baseURL: DEFAULT_BASE_URL })
const auth = Auth.none

export const httpTransport = HttpTransport.sseJson.with<OpenAIResponsesBody>()
export const channelTransport = OpenResponsesChannel.transport<OpenAIResponsesBody>
export const transport = channelTransport({
  id: ADAPTER,
  name: NAME,
  rotateAfterMs: WEBSOCKET_ROTATE_AFTER_MS,
  headers: (headers) => Headers.set(headers, "openai-beta", headers["openai-beta"] ?? WEBSOCKET_PROTOCOL_HEADER),
})

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  providerMetadataKey: "openai",
  protocol,
  endpoint,
  auth,
  transport,
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})

/** Native route identity is package provenance; user-controlled route ids are insufficient. */
export const supportsCompaction = (model: LanguageModel) =>
  model.route.provider === "openai" && model.route.id === ADAPTER && model.route.body === protocol.body

const cloneNativeRouteForCompaction = (source: LanguageModel) => {
  const original = source.route
  const route = Route.make({
    id: original.id,
    provider: original.provider,
    providerMetadataKey: original.providerMetadataKey,
    protocol,
    endpoint: original.endpoint,
    auth: original.auth,
    transport: original.transport,
    defaults: {
      ...original.defaults,
      providerOptions: withoutCompactionProviderOptions(original.defaults.providerOptions),
      http: withoutCompactionHttp(original.defaults.http),
    },
  })
  compactionRoutes.add(route)
  return route
}

const withCompactionTrigger = (request: LLMRequest) => {
  const modelDefaults = request.model.defaults
  const route = cloneNativeRouteForCompaction(request.model)
  return LLMRequest.update(request, {
    model: LanguageModel.update(request.model, {
      route,
      defaults:
        modelDefaults === undefined
          ? undefined
          : {
              ...modelDefaults,
              providerOptions: withoutCompactionProviderOptions(modelDefaults.providerOptions),
              http: withoutCompactionHttp(modelDefaults.http),
            },
    }),
    tools: [],
    toolChoice: undefined,
    http: withoutCompactionHttp(request.http),
    providerOptions: mergeProviderOptions(withoutCompactionProviderOptions(request.providerOptions), { store: false }),
  })
}

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const sameJson = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => sameJson(item, right[index]))
  if (!isJsonRecord(left) || !isJsonRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  )
}

const isCompactionEndpoint = (url: string) => {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(url).pathname)
  } catch {
    return false
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
  return segments.at(-2) === "responses" && segments.at(-1) === "compact"
}

const compactionHttpFields = Effect.fn("OpenAIResponses.compactionHttpFields")(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const web = yield* HttpClientRequest.toWeb(request)
  const text = yield* Effect.promise(() => web.clone().text())
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return yield* ProviderShared.invalidRequest("OpenAI Responses compaction middleware produced a malformed JSON body")
  }
  if (!isJsonRecord(body))
    return yield* ProviderShared.invalidRequest("OpenAI Responses compaction middleware must send a JSON object body")
  return {
    method: web.method,
    url: web.url,
    body,
  }
})

const sealCompactionHttp =
  (middleware?: HttpMiddleware): HttpMiddleware =>
  (request, handler) => {
    const sealed = (candidate: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const [expected, actual] = yield* Effect.all([compactionHttpFields(request), compactionHttpFields(candidate)])
        if (expected.method !== "POST" || actual.method !== expected.method)
          return yield* ProviderShared.invalidRequest(
            "OpenAI Responses compaction middleware must preserve the POST method",
          )
        if (isCompactionEndpoint(actual.url))
          return yield* ProviderShared.invalidRequest(
            "OpenAI Responses compaction middleware may not target the retired /responses/compact endpoint",
          )
        for (const key of COMPACTION_BODY_KEYS) {
          const expectedHas = Object.hasOwn(expected.body, key)
          const actualHas = Object.hasOwn(actual.body, key)
          if (expectedHas !== actualHas || (expectedHas && !sameJson(expected.body[key], actual.body[key])))
            return yield* ProviderShared.invalidRequest(
              `OpenAI Responses compaction middleware may not alter protected body field: ${key}`,
            )
        }
        // Candidate bytes are intentionally forwarded as-is once protected fields validate.
        return yield* handler(candidate)
      })
    return middleware ? middleware(request, sealed) : sealed(request)
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

const invalidCompactOutput = (message: string) =>
  new AIError({ reason: new InvalidProviderOutputError({ message, route: ADAPTER }) })

/** Runs the native trigger as a normal Responses stream and accepts exactly one opaque checkpoint. */
export const compactV2 = Effect.fn("OpenAIResponses.compactV2")(function* (
  source: LLMRequest,
  stream: StreamRequest,
  options?: StreamOptions,
) {
  if (!supportsCompaction(source.model))
    return yield* ProviderShared.invalidRequest(
      `OpenAI Responses compaction requires the native OpenAI Responses route; received ${source.model.route.id}`,
    )

  const { webSocket: _webSocket, ...httpOptions } = options ?? {}
  const result = yield* stream(withCompactionTrigger(source), {
    ...httpOptions,
    http: sealCompactionHttp(options?.http),
  }).pipe(
    Stream.runFold(emptyCompactionStreamState, (state, event) => {
      if (event.type === "provider-checkpoint")
        return { ...state, checkpoints: [...state.checkpoints, { reset: event.reset, item: event.item }] }
      if (event.type === "provider-error")
        return { ...state, providerError: { message: event.message, classification: event.classification } }
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
      invalidCompactOutput(`OpenAI Responses compaction emitted unexpected ${result.unexpected} output`),
    )
  if (result.checkpoints.length !== 1)
    return yield* Effect.fail(
      invalidCompactOutput(
        `OpenAI Responses compaction returned ${result.checkpoints.length} checkpoint items instead of exactly one`,
      ),
    )

  const checkpoint = result.checkpoints[0]
  if (!checkpoint.reset || !OpenAICompaction.isCompactionItem(checkpoint.item) || checkpoint.item.type !== "compaction")
    return yield* Effect.fail(
      invalidCompactOutput("OpenAI Responses compaction did not return one replayable compaction item"),
    )

  return [structuredClone(checkpoint.item)]
})

export * as OpenAIResponses from "./openai-responses.js"
