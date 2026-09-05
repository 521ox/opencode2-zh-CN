import { describe, expect, test } from "bun:test"
import {
  LanguageModel,
  LLMClient,
  LLMRequest,
  Message,
  SystemPart,
  ToolDefinition,
  ToolResultPart,
} from "@opencode-ai/ai"
import { Gemini } from "@opencode-ai/ai/protocols/gemini"
import { OpenAIChat, OpenAICompatibleResponses } from "@opencode-ai/ai/protocols"
import { OpenAIResponses } from "@opencode-ai/ai/protocols/openai-responses"
import { compileRequest } from "@opencode-ai/ai/route/client"
import { RequestExecutor } from "@opencode-ai/ai/route"
import { Config } from "@opencode-ai/core/config"
import { PluginHooks } from "@opencode-ai/core/plugin/hooks"
import {
  SessionModelRequest,
  boundImages,
  projectLargeToolResults,
  shouldPruneToolResults,
  toolResultPruneThreshold,
  unsupportedParts,
} from "@opencode-ai/core/session/model-request"
import { TOOL_RESULT_PRUNE_METADATA } from "@opencode-ai/core/session/runner/to-llm-message"
import { SessionModelTransport } from "@opencode-ai/core/session/model-transport"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Token } from "@opencode-ai/core/util/token"
import { Agent } from "@opencode-ai/schema/agent"
import { Document, Info } from "@opencode-ai/schema/config"
import { ConfigCompaction } from "@opencode-ai/schema/config/compaction"
import { Location } from "@opencode-ai/schema/location"
import { Money } from "@opencode-ai/schema/money"
import { Project } from "@opencode-ai/schema/project"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Session } from "@opencode-ai/schema/session"
import type { Content } from "@opencode-ai/schema/tool"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { ConfigProvider, DateTime, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "./lib/effect"

const capabilities = (input: string[]) => ({ tools: true, input, output: ["text"] })

const it = testEffect(
  LayerNode.compile(LayerNode.group([SessionModelRequest.node, PluginHooks.node, Config.node]), [
    [SessionModelTransport.node, SessionModelTransport.makeLayer({ open: () => Effect.die("Unexpected connection") })],
    [Config.node, Config.testLayer()],
  ]),
)

const pruneIt = testEffect(
  LayerNode.compile(LayerNode.group([SessionModelRequest.node, PluginHooks.node, Config.node]), [
    [SessionModelTransport.node, SessionModelTransport.makeLayer({ open: () => Effect.die("Unexpected connection") })],
    [
      Config.node,
      Config.testLayer([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ prune: true }) }),
        }),
      ]),
    ],
  ]),
)

const requestInput = (
  model: LanguageModel,
  options?: { readonly messages?: Message[]; readonly input?: string[] },
) => ({
  scope: {
    session: Session.Info.make({
      id: Session.ID.make("ses_request_options"),
      projectID: Project.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
    }),
    agentID: Agent.ID.make("build"),
    model: SessionRunnerModel.resolved(model, {
      capabilities: {
        ...capabilities(options?.input ?? ["text"]),
        responsesWebsockets: model.provider === "openai",
      },
      cost: [],
      limit: { context: 200_000, output: 32_000 },
    }),
  },
  transcript: { system: [], messages: options?.messages ?? [Message.user("Hello")] },
})

const legacyUnsupportedParts = (messages: LLMRequest["messages"], supported: string[]) => {
  const modality = (mime: string) => {
    if (mime.startsWith("image/")) return "image"
    if (mime.startsWith("audio/")) return "audio"
    if (mime.startsWith("video/")) return "video"
    if (mime === "application/pdf") return "pdf"
  }
  const unsupported = (mime: string, name: string | undefined): Extract<Content, { type: "text" }> | undefined => {
    const type = modality(mime)
    if (!type || supported.some((item) => item.startsWith(type))) return
    return {
      type: "text",
      text: `ERROR: Cannot read ${name ? `"${name}"` : type} (this model does not support ${type} input). Inform the user.`,
    }
  }
  return messages.map((message) =>
    Message.make({
      ...message,
      content: message.content.map((part) => {
        if (part.type === "media") return unsupported(part.mediaType, part.filename) ?? part
        if (part.type !== "tool-result" || part.result.type !== "content") return part
        return {
          ...part,
          result: {
            ...part.result,
            value: part.result.value.map((item: Content) => {
              if (item.type !== "file") return item
              return unsupported(item.mime, item.name) ?? item
            }),
          },
        }
      }),
    }),
  )
}

const legacyBoundImages = (messages: LLMRequest["messages"]) => {
  const trigger = 25 * 1024 * 1024
  const target = 15 * 1024 * 1024
  const removedText =
    "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]"
  const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")
  const size = (data: string | Uint8Array) =>
    typeof data === "string" ? Buffer.byteLength(data) : Math.ceil(data.byteLength / 3) * 4
  const bytes = messages.reduce(
    (total, message) =>
      total +
      message.content.reduce((sum, part) => {
        if (part.type === "media" && isImage(part.mediaType)) return sum + size(part.data)
        if (part.type !== "tool-result" || part.result.type !== "content") return sum
        return (
          sum +
          part.result.value.reduce(
            (value: number, item: Content) =>
              value + (item.type === "file" && isImage(item.mime) ? Buffer.byteLength(item.uri) : 0),
            0,
          )
        )
      }, 0),
    0,
  )
  if (bytes <= trigger) return messages
  let removed = 0
  return messages.map((message) =>
    Message.make({
      ...message,
      content: message.content.map((part) => {
        if (part.type === "media" && isImage(part.mediaType) && bytes - removed > target) {
          removed += size(part.data)
          return Message.text(removedText)
        }
        if (part.type !== "tool-result" || part.result.type !== "content") return part
        return {
          ...part,
          result: {
            ...part.result,
            value: part.result.value.map((item: Content) => {
              if (item.type !== "file" || !isImage(item.mime) || bytes - removed <= target) return item
              removed += Buffer.byteLength(item.uri)
              return { type: "text" as const, text: removedText }
            }),
          },
        }
      }),
    }),
  )
}

const legacyNormalizeMessages = (messages: LLMRequest["messages"], supported: string[]) =>
  legacyBoundImages(legacyUnsupportedParts(messages, supported))

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

const legacyPromptJSON = (request: Pick<LLMRequest, "system" | "messages" | "tools">) =>
  JSON.stringify(
    { system: request.system, messages: request.messages, tools: request.tools },
    function (this: unknown, key, value) {
      if (key === TOOL_RESULT_PRUNE_METADATA) return undefined
      if (value instanceof Uint8Array) return `[binary:${value.byteLength}]`
      if (value instanceof ArrayBuffer) return `[binary:${value.byteLength}]`
      if (!this || typeof this !== "object") return value
      const parent = this as { readonly type?: unknown }
      if (key === "data" && parent.type === "media" && typeof value === "string") return `[media:${base64Bytes(value)}]`
      if (key === "uri" && parent.type === "file" && typeof value === "string" && value.startsWith("data:"))
        return `[media:${dataURIBytes(value)}]`
      return value
    },
  )

const legacyPromptTokenEstimate = (request: Pick<LLMRequest, "system" | "messages" | "tools">) =>
  Token.estimate(legacyPromptJSON(request))

describe("SessionModelRequest.promptTokenEstimate", () => {
  test("matches the legacy stringify oracle across escaping, metadata, media, and pruning boundaries", () => {
    const request = {
      system: [SystemPart.make('system "\\\b\f\n\r\t\u0001 \ud800 😀')],
      messages: [
        Message.make({
          role: "user",
          content: [
            {
              type: "media",
              mediaType: "image/png",
              data: "aGVsbG8=",
              metadata: { [TOOL_RESULT_PRUNE_METADATA]: "omit" },
            },
            { type: "media", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
            {
              type: "tool-result",
              id: "result",
              name: "read",
              result: {
                type: "content",
                value: [
                  { type: "file", uri: "data:application/octet-stream;base64,AA==", mime: "application/octet-stream" },
                ],
              },
              providerMetadata: {
                provider: {
                  "quoted\\key": "line\n😀",
                  number: 1.5,
                  negativeZero: -0,
                  infinite: Number.POSITIVE_INFINITY,
                  truthy: true,
                  empty: null,
                  omitted: undefined,
                  wrapped: new String('wrapped "value"'),
                  values: [undefined, null, false, new ArrayBuffer(3)],
                  [TOOL_RESULT_PRUNE_METADATA]: "omit",
                },
              },
            },
          ],
        }),
      ],
      tools: [ToolDefinition.make({ name: "tool\n😀", description: "description", inputSchema: { type: "object" } })],
    } satisfies Pick<LLMRequest, "system" | "messages" | "tools">
    const expected = legacyPromptTokenEstimate(request)

    expect(SessionModelRequest.promptTokenEstimate(request)).toBe(expected)
    const contextWindow = Math.floor(expected / 0.8)
    expect(toolResultPruneThreshold(contextWindow)).toBe(expected)
    expect(shouldPruneToolResults(expected - 1, contextWindow)).toBe(false)
    expect(shouldPruneToolResults(expected, contextWindow)).toBe(true)
  })

  test("matches the legacy stringify oracle for a large transcript at every token rounding residue", () => {
    for (let suffix = 0; suffix < 4; suffix++) {
      const request = {
        system: [],
        messages: [Message.user(`${"x".repeat(1_000_000)}${"y".repeat(suffix)}`)],
        tools: [],
      } satisfies Pick<LLMRequest, "system" | "messages" | "tools">
      expect(SessionModelRequest.promptTokenEstimate(request)).toBe(legacyPromptTokenEstimate(request))
    }
  })

  test("snapshots array length before index getters shrink or expand it", () => {
    const request = (mode: "shrink" | "expand") => {
      const values = mode === "shrink" ? ["first", "second", "third"] : ["first"]
      Object.defineProperty(values, "0", {
        enumerable: true,
        get: () => {
          if (mode === "shrink") values.length = 1
          if (mode === "expand") values.push("second", "third")
          return "first"
        },
      })
      return {
        system: [],
        messages: [
          Message.make({
            role: "user",
            content: { type: "text", text: "getter", providerMetadata: { provider: { values } } },
          }),
        ],
        tools: [],
      } satisfies Pick<LLMRequest, "system" | "messages" | "tools">
    }

    for (const [mode, serialized] of [
      ["shrink", '["first",null,null]'],
      ["expand", '["first"]'],
    ] as const) {
      const legacy = legacyPromptJSON(request(mode))
      const expected = Token.estimate(legacy)
      expect(legacy).toContain(serialized)
      expect(SessionModelRequest.promptTokenEstimate(request(mode))).toBe(expected)
      const contextWindow = Math.floor(expected / 0.8)
      expect(toolResultPruneThreshold(contextWindow)).toBe(expected)
      expect(shouldPruneToolResults(expected - 1, contextWindow)).toBe(false)
      expect(shouldPruneToolResults(expected, contextWindow)).toBe(true)
    }
  })

  test("fails like legacy stringify for primitive and boxed BigInt provider metadata", () => {
    const request = (value: bigint | BigInt) =>
      ({
        system: [],
        messages: [
          Message.make({
            role: "user",
            content: { type: "text", text: "bigint", providerMetadata: { provider: { value } } },
          }),
        ],
        tools: [],
      }) satisfies Pick<LLMRequest, "system" | "messages" | "tools">

    for (const value of [1n, Object(1n)]) {
      expect(() => legacyPromptTokenEstimate(request(value))).toThrow(TypeError)
      expect(() => SessionModelRequest.promptTokenEstimate(request(value))).toThrow(TypeError)
    }
  })
})

describe("SessionModelRequest.context options", () => {
  it.effect("compiles ordered generation and provider overrides without mutating defaults", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const hooks = yield* PluginHooks.Service
      const model = Gemini.route
        .with({
          generation: { maxTokens: 100, topP: 0.7 },
          providerOptions: { thinkingConfig: { includeThoughts: true, thinkingBudget: 256 } },
        })
        .model({
          id: "gemini-2.5-flash",
          defaults: {
            generation: { temperature: 0.8 },
            providerOptions: { thinkingConfig: { thinkingBudget: 512 } },
          },
        })
      const baseline = yield* requests.prepare(requestInput(model))
      expect(baseline.request.generation).toBeUndefined()
      expect(baseline.request.providerOptions).toBeUndefined()
      const first = yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          expect(event.generation).toEqual({})
          expect(event.providerOptions).toEqual({})
          event.generation = {
            maxTokens: 2048,
            temperature: 0.2,
            topK: 40,
            frequencyPenalty: 0.1,
            presencePenalty: 0.3,
            seed: 42,
            stop: ["END"],
          }
          event.providerOptions = { thinkingConfig: { thinkingBudget: 1024 } }
        }),
      )
      const second = yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          expect(event.generation.temperature).toBe(0.2)
          expect(event.providerOptions.thinkingConfig).toEqual({ thinkingBudget: 1024 })
          event.generation.temperature = 0
          event.generation.stop?.push("STOP")
        }),
      )
      const prepared = yield* requests.prepare(requestInput(model))
      expect((yield* compileRequest(prepared.request)).body).toMatchObject({
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0,
          topP: 0.7,
          topK: 40,
          frequencyPenalty: 0.1,
          presencePenalty: 0.3,
          seed: 42,
          stopSequences: ["END", "STOP"],
          thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
        },
      })
      // Each new request starts with fresh override objects, even while hooks remain registered.
      expect((yield* requests.prepare(requestInput(model))).request.generation).toEqual(prepared.request.generation)
      yield* first.dispose
      yield* second.dispose
      const unhooked = yield* requests.prepare(requestInput(model))
      expect(unhooked.request.generation).toBeUndefined()
      expect(unhooked.request.providerOptions).toBeUndefined()
      expect((yield* compileRequest(unhooked.request)).body).toEqual((yield* compileRequest(baseline.request)).body)
      expect(model.defaults?.generation).toEqual({ temperature: 0.8 })
      expect(model.route.defaults.generation).toEqual({ maxTokens: 100, topP: 0.7 })
      expect(model.defaults?.providerOptions).toEqual({ thinkingConfig: { thinkingBudget: 512 } })
      expect(model.route.defaults.providerOptions).toEqual({
        thinkingConfig: { includeThoughts: true, thinkingBudget: 256 },
      })
    }),
  )

  it.effect("compiles OpenAI semantic reasoning options without revoking WebSocket transport", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", () => Effect.die("Other-provider hook must not run"), {
        providerID: "google",
      })
      yield* hooks.register(
        "session",
        "context",
        (event) =>
          Effect.sync(() => {
            event.generation.maxTokens = 8000
            event.providerOptions.reasoningEffort = "high"
          }),
        { providerID: "openai" },
      )
      const input = requestInput(OpenAIResponses.route.model({ id: "gpt-5.5" }))
      const prepared = yield* requests.prepare({ ...input, webSocket: "session" })
      expect(prepared.options.webSocket).toBeDefined()
      expect(prepared.options.http).toBeUndefined()
      expect((yield* compileRequest(prepared.request)).body).toMatchObject({
        max_output_tokens: 8000,
        reasoning: { effort: "high" },
        store: false,
        include: ["reasoning.encrypted_content"],
      })
      const excluded = yield* requests.prepare({ ...input, contextHooks: false })
      expect(excluded.request.generation).toBeUndefined()
      expect(excluded.request.providerOptions).toBeUndefined()
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { OPENCODE_EXPERIMENTAL_OPENAI_RESPONSES_WEBSOCKET: "true" } }),
        ),
      ),
    ),
  )

  it.effect("seals session HTTP hook bodies before compatible Responses dispatch", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const hooks = yield* PluginHooks.Service
      const model = OpenAICompatibleResponses.route
        .with({ provider: "example", endpoint: { baseURL: "https://responses.example.test/v1" } })
        .model({ id: "example-model" })
      yield* hooks.register(
        "session",
        "http.request",
        (event) =>
          Effect.sync(() => {
            event.request = new Request(event.request, {
              method: event.request.method,
              body: JSON.stringify({
                store: true,
                context_management: [{ type: "compaction", compact_threshold: 1 }],
                input: [{ type: "compaction_trigger" }, { role: "user", content: "Retained by hook" }],
                hook_extension: true,
              }),
            })
          }),
        { providerID: "example" },
      )
      const prepared = yield* requests.prepare(requestInput(model))
      let dispatched = 0
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            dispatched++
            const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
            const body = yield* Effect.promise(() => web.clone().json())
            expect(body).toEqual({
              input: [{ role: "user", content: "Retained by hook" }],
              hook_extension: true,
              store: false,
            })
            return HttpClientResponse.fromWeb(
              request,
              new Response('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n', {
                headers: { "content-type": "text/event-stream" },
              }),
            )
          }),
        ),
      )
      const executor = RequestExecutor.layer.pipe(Layer.provide(http))

      yield* LLMClient.generate(prepared.request, prepared.options).pipe(
        Effect.provide(LLMClient.layer.pipe(Layer.provide(executor))),
      )
      expect(prepared.options.http).toBeDefined()
      expect(dispatched).toBe(1)
    }),
  )

  it.effect("uses hosted web search only for wildcard-authorized native OpenAI Responses", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const websearch = ToolDefinition.make({
        name: "websearch",
        description: "Search the web.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      })
      const prepare = (model: LanguageModel, effect: "allow" | "ask" | "deny") => {
        const input = requestInput(model)
        return requests.prepare({
          ...input,
          scope: {
            ...input.scope,
            permissions: [{ action: "websearch", resource: "*", effect }],
            tools: { definitions: [websearch], execute: () => Effect.die("unused") },
          },
        })
      }

      const native = OpenAIResponses.route.model({ id: "gpt-5" })
      const allowed = yield* prepare(native, "allow")
      const asked = yield* prepare(native, "ask")
      const compatibility = yield* prepare(OpenAIChat.route.model({ id: "gpt-5" }), "allow")

      expect((yield* compileRequest(allowed.request)).body.tools).toEqual([{ type: "web_search" }])
      expect((yield* compileRequest(asked.request)).body.tools).toBeUndefined()
      expect((yield* compileRequest(compatibility.request)).body.tools).toMatchObject([
        { type: "function", function: { name: "websearch" } },
      ])
    }),
  )

  it.effect("keeps a future protected suffix out of native auxiliary preparation without disabling context hooks", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const hooks = yield* PluginHooks.Service
      const ordinary = SystemPart.make("ordinary post-hook system context")
      const protectedSystem = SystemPart.make("future protected session rules")
      let hookCalls = 0
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          hookCalls++
          event.system.push(ordinary)
        }),
      )
      const model = OpenAIResponses.route.model({ id: "gpt-5" })
      const normal = yield* requests.prepare({ ...requestInput(model), protectedSystem })
      const auxiliary = yield* requests.prepare({ ...requestInput(model), protectedSystem, includeSessionRules: false })

      expect(hookCalls).toBe(2)
      expect(JSON.stringify(auxiliary.request.system)).toBe(JSON.stringify(normal.request.system.slice(0, -1)))
      expect(JSON.stringify(auxiliary.request.messages)).toBe(JSON.stringify(normal.request.messages))
      expect(normal.request.system.at(-1)?.text).toBe("future protected session rules")
      expect(auxiliary.request.system.map((part) => part.text)).not.toContain("future protected session rules")
      expect(auxiliary.request.system.map((part) => part.text)).toContain("ordinary post-hook system context")
    }),
  )
})

describe("SessionModelRequest.unsupportedParts", () => {
  test("replaces unsupported user media with a visible error", () => {
    const messages = unsupportedParts(
      [
        Message.user([
          Message.text("Describe these files"),
          { type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "logo.png" },
          { type: "media", mediaType: "application/pdf", data: "JVBERg==", filename: "document.pdf" },
        ]),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content).toEqual([
      Message.text("Describe these files"),
      Message.text('ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.'),
      Message.text('ERROR: Cannot read "document.pdf" (this model does not support pdf input). Inform the user.'),
    ])
  })

  test("replaces unsupported media nested in tool results", () => {
    const messages = unsupportedParts(
      [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
              ],
            },
          }),
        ),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.',
          },
        ],
      },
    })
  })

  test("preserves legacy always-copy and tool-result aliasing boundaries", () => {
    const tool = ToolResultPart.make({
      id: "supported",
      name: "read",
      result: {
        type: "content",
        value: [
          { type: "text", text: "supported" },
          { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
        ],
      },
    })
    const message = Message.user([{ type: "media", mediaType: "image/png", data: "aGVsbG8=" }, tool])
    const messages = [message]
    const result = unsupportedParts(messages, capabilities(["text", "image"]))

    expect(result).not.toBe(messages)
    expect(result[0]).not.toBe(message)
    expect(result[0]?.content).not.toBe(message.content)
    expect(result[0]?.content[0]).not.toBe(message.content[0])
    const copiedTool = result[0]?.content[1]
    expect(copiedTool).toMatchObject({ type: "tool-result" })
    expect(copiedTool).not.toBe(tool)
    if (!copiedTool || copiedTool.type !== "tool-result" || copiedTool.result.type !== "content")
      throw new Error("Expected copied tool-result content")
    expect(copiedTool.result).not.toBe(tool.result)
    expect(copiedTool.result.value).not.toBe(tool.result.value)
    ;(result[0]?.content as Array<(typeof message.content)[number]>).push(Message.text("output-only"))
    ;(copiedTool.result.value as Content[]).push({ type: "text", text: "tool-output-only" })
    expect(message.content).toHaveLength(2)
    expect(tool.result.value).toHaveLength(2)
  })
})

describe("SessionModelRequest.boundImages", () => {
  test("preserves images below the trigger", () => {
    const messages = [Message.user({ type: "media", mediaType: "image/png", data: "aGVsbG8=" })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const image = "a".repeat(9 * 1024 * 1024)
    const messages = [
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "first.png" }),
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "second.png" }),
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "third.png" }),
    ]
    const result = boundImages(messages)

    expect(result[0]?.content[0]).toMatchObject({ type: "text" })
    expect(result[1]?.content[0]).toMatchObject({ type: "text" })
    expect(result[2]?.content[0]).toMatchObject({ type: "media", filename: "third.png" })
  })

  test("replaces images nested in tool results", () => {
    const image = "a".repeat(13 * 1024 * 1024)
    const result = boundImages([
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "first.png" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "second.png" },
            ],
          },
        }),
      ),
    ])

    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [{ type: "text" }, { type: "file", name: "second.png" }],
      },
    })
  })
})

describe("SessionModelRequest fused message normalization", () => {
  it.effect("allocates no messages on ordinary text-only and large-history paths", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const hooks = yield* PluginHooks.Service
      let preservedRoot = false
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.messages = new Proxy(event.messages, {
            get(target, property, receiver) {
              if (property !== "map") return Reflect.get(target, property, receiver)
              return <U>(callback: (value: Message, index: number, array: Message[]) => U, thisArg?: unknown) => {
                preservedRoot = true
                return target.map(callback, thisArg)
              }
            },
          })
        }),
      )

      const first = Message.user([Message.text("hello"), Message.text("world")])
      const history = [first, ...Array.from({ length: 4_095 }, (_, index) => Message.user(`history-${index}`))]
      const prepared = yield* requests.prepare(
        requestInput(OpenAIChat.route.model({ id: "gpt-4.1" }), { messages: history, input: ["text"] }),
      )
      expect(preservedRoot).toBe(true)
      expect(prepared.request.messages).toHaveLength(history.length)
      for (let index = 0; index < history.length; index++) {
        expect(prepared.request.messages[index]).toBe(history[index])
        expect(prepared.request.messages[index]?.content).toBe(history[index]?.content)
        expect(prepared.request.messages[index]?.content[0]).toBe(history[index]?.content[0])
      }
    }),
  )

  it.effect("matches the legacy two-function oracle across randomized media and tool-result content", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const model = OpenAIChat.route.model({ id: "gpt-4.1" })
      const supportedMatrix = [
        ["text"],
        ["text", "image"],
        ["text", "audio"],
        ["text", "pdf"],
        ["text", "image", "audio", "pdf"],
      ]
      const mimes = ["image/png", "IMAGE/PNG", "audio/wav", "application/pdf", "application/octet-stream"]
      let seed = 0x5eed1234
      const random = () => {
        seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
        return seed
      }

      for (let sample = 0; sample < 64; sample++) {
        const supported = supportedMatrix[random() % supportedMatrix.length] ?? ["text"]
        const messages = Array.from({ length: 1 + (random() % 4) }, (_, messageIndex) => {
          const parts: Array<LLMRequest["messages"][number]["content"][number]> = [
            Message.text(`sample-${sample}-${messageIndex}`),
          ]
          const mime = mimes[random() % mimes.length] ?? "application/octet-stream"
          parts.push({
            type: "media",
            mediaType: mime,
            data: random() % 2 === 0 ? `payload-${random()}` : new Uint8Array([random() & 0xff, random() & 0xff]),
            filename: `media-${messageIndex}`,
          })
          return Message.user(parts)
        }).flatMap((message, messageIndex) => {
          if (random() % 2 !== 0) return [message]
          const fileMime = mimes[random() % mimes.length] ?? "application/octet-stream"
          return [
            message,
            Message.tool(
              ToolResultPart.make({
                id: `tool-${sample}-${messageIndex}`,
                name: "read",
                result: {
                  type: "content",
                  value: [
                    { type: "text", text: "tool text" },
                    { type: "file", uri: `data:${fileMime};base64,${random()}`, mime: fileMime, name: "tool-file" },
                  ],
                },
              }),
            ),
          ]
        })
        const snapshot = structuredClone(messages)
        const expected = legacyNormalizeMessages(messages, supported)
        const prepared = yield* requests.prepare(requestInput(model, { messages, input: supported }))

        expect(prepared.request.messages).toEqual(expected)
        expect(messages).toEqual(snapshot)
      }
    }),
  )

  it.effect("matches trigger boundaries and removes mixed image inputs in original order", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const model = OpenAIChat.route.model({ id: "gpt-4.1" })
      const trigger = 25 * 1024 * 1024
      const payload = "a".repeat(trigger + 1)
      for (const delta of [-1, 0, 1]) {
        const messages = [
          Message.user({
            type: "media",
            mediaType: "image/png",
            data: payload.slice(0, trigger + delta),
            filename: `boundary-${delta}.png`,
          }),
        ]
        const expected = legacyNormalizeMessages(messages, ["text", "image"])
        const prepared = yield* requests.prepare(requestInput(model, { messages, input: ["text", "image"] }))
        expect(prepared.request.messages).toEqual(expected)
        if (delta <= 0) expect(prepared.request.messages[0]).toBe(messages[0])
        else expect(prepared.request.messages[0]).not.toBe(messages[0])
      }

      const mixed = [
        Message.user([
          { type: "media", mediaType: "image/png", data: new Uint8Array([1]), filename: "first.png" },
          { type: "media", mediaType: "image/png", data: payload, filename: "second.png" },
          { type: "media", mediaType: "image/png", data: "tail", filename: "third.png" },
        ]),
      ]
      const snapshot = structuredClone(mixed)
      const expected = legacyNormalizeMessages(mixed, ["text", "image"])
      const prepared = yield* requests.prepare(
        requestInput(model, { messages: mixed, input: ["text", "image", "audio", "pdf"] }),
      )
      expect(prepared.request.messages).toEqual(expected)
      expect(prepared.request.messages[0]?.content.map((part) => part.type)).toEqual(["text", "text", "media"])
      expect(mixed).toEqual(snapshot)
    }),
  )

  it.effect("counts only images that remain after unsupported conversion, including tool-result files", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const model = OpenAIChat.route.model({ id: "gpt-4.1" })
      const image = "i".repeat(13 * 1024 * 1024)
      const messages = [
        Message.user([
          { type: "media", mediaType: "audio/wav", data: image, filename: "audio.wav" },
          { type: "media", mediaType: "application/pdf", data: image, filename: "document.pdf" },
          { type: "media", mediaType: "image/png", data: image, filename: "user.png" },
        ]),
        Message.tool(
          ToolResultPart.make({
            id: "tool-images",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "file", uri: image, mime: "image/png", name: "tool.png" },
                { type: "file", uri: image, mime: "audio/wav", name: "tool.wav" },
              ],
            },
          }),
        ),
      ]
      const snapshot = structuredClone(messages)
      const expected = legacyNormalizeMessages(messages, ["text", "image"])
      const prepared = yield* requests.prepare(requestInput(model, { messages, input: ["text", "image"] }))

      expect(prepared.request.messages).toEqual(expected)
      expect(messages).toEqual(snapshot)
      expect((yield* compileRequest(prepared.request)).body).toEqual(
        (yield* compileRequest(LLMRequest.update(prepared.request, { messages: expected }))).body,
      )
    }),
  )
})

describe("SessionModelRequest.tool result projection", () => {
  test("uses the earlier of 80% prompt capacity and 90% remote threshold", () => {
    expect(toolResultPruneThreshold(500_000, 424_000)).toBe(381_600)
    expect(toolResultPruneThreshold(272_000, 212_000)).toBe(190_800)
    expect(shouldPruneToolResults(190_799, 272_000, 212_000)).toBe(false)
    expect(shouldPruneToolResults(190_800, 272_000, 212_000)).toBe(true)
  })

  test("uses output-path provenance when projecting pure-text local results without splitting Unicode code points", () => {
    const marker = Symbol("tool-result-prune")
    const source = `${"HEAD-"}${"x".repeat(8_190)}😀TAIL`
    const messages = [
      Message.tool(
        ToolResultPart.make({
          id: "call_local",
          name: "read",
          result: { type: "text", value: source },
          metadata: { [TOOL_RESULT_PRUNE_METADATA]: { marker, outputPath: "C:/tmp/full-output.txt" } },
        }),
      ),
      Message.tool(
        ToolResultPart.make({
          id: "call_hosted",
          name: "web_search",
          providerExecuted: true,
          result: { type: "text", value: source },
          metadata: { [TOOL_RESULT_PRUNE_METADATA]: { marker } },
        }),
      ),
    ]
    const projected = projectLargeToolResults(messages, marker)
    const local = projected[0]?.content[0]
    const hosted = projected[1]?.content[0]

    expect(local).toMatchObject({ type: "tool-result", result: { type: "text" } })
    if (!local || local.type !== "tool-result" || local.result.type !== "text") throw new Error("Expected text result")
    expect(local.result.value).toStartWith("HEAD-")
    expect(local.result.value).toEndWith("😀TAIL")
    expect(local.result.value).toContain("characters trimmed for context. Full output: C:/tmp/full-output.txt")
    expect(local.metadata).toBeUndefined()
    expect(hosted).toMatchObject({ type: "tool-result", result: { type: "text", value: source } })
  })
})

describe("SessionModelRequest post-hook tool result projection", () => {
  pruneIt.effect("projects reconstructed final occurrences without leaking internal metadata", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const hooks = yield* PluginHooks.Service
      const rebuilt = `REBUILT-${"r".repeat(12_000)}😀REBUIILT-TAIL`
      const multiFirst = `MULTI-FIRST-${"a".repeat(7_000)}`
      const multiLast = `${"b".repeat(7_000)}😀MULTI-LAST`
      const hosted = `HOSTED-${"h".repeat(12_000)}`
      const skill = `SKILL-${"s".repeat(12_000)}`
      const subagent = `SUBAGENT-${"u".repeat(12_000)}`
      const mixed = `MIXED-${"m".repeat(12_000)}`
      const remote = Message.make({
        role: "user",
        content: [
          {
            type: "text",
            text: "[OpenCode remote compaction checkpoint]",
            providerMetadata: {
              opencode: {
                remoteCompaction: {
                  output: [{ type: "compaction", id: "cmp_projection", encrypted_content: "opaque" }],
                },
              },
            },
          },
        ],
      })
      const original = Message.tool(
        ToolResultPart.make({
          id: "repeat",
          name: "read",
          result: { type: "text", value: `OLD-${"o".repeat(12_000)}` },
        }),
      )
      const input = requestInput(OpenAIResponses.route.model({ id: "gpt-5" }))
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.messages.splice(
            0,
            event.messages.length,
            remote,
            Message.tool(
              ToolResultPart.make({
                id: "repeat",
                name: "web_search",
                providerExecuted: true,
                result: { type: "text", value: hosted },
              }),
            ),
            Message.tool(ToolResultPart.make({ id: "repeat", name: "read", result: { type: "text", value: rebuilt } })),
            Message.tool(
              ToolResultPart.make({
                id: "multi",
                name: "read",
                result: {
                  type: "content",
                  value: [
                    { type: "text", text: multiFirst },
                    { type: "text", text: multiLast },
                  ],
                },
              }),
            ),
            Message.tool(
              ToolResultPart.make({
                id: "mixed",
                name: "read",
                result: {
                  type: "content",
                  value: [
                    { type: "text", text: mixed },
                    {
                      type: "file",
                      uri: "data:application/octet-stream;base64,AA==",
                      mime: "application/octet-stream",
                    },
                  ],
                },
              }),
            ),
            Message.tool(ToolResultPart.make({ id: "skill", name: "skill", result: { type: "text", value: skill } })),
            Message.tool(
              ToolResultPart.make({ id: "subagent", name: "subagent", result: { type: "text", value: subagent } }),
            ),
          )
        }),
      )
      const prepared = yield* requests.prepare({
        ...input,
        transcript: { system: [], messages: [original] },
        compactThreshold: 2_000,
      })
      const results = prepared.request.messages.flatMap((message) =>
        message.content.filter(
          (part): part is Extract<(typeof message.content)[number], { type: "tool-result" }> =>
            part.type === "tool-result",
        ),
      )
      const local = results.find((part) => part.id === "repeat" && !part.providerExecuted)
      const multi = results.find((part) => part.id === "multi")
      const hostedResult = results.find((part) => part.id === "repeat" && part.providerExecuted)
      const mixedResult = results.find((part) => part.id === "mixed")
      const skillResult = results.find((part) => part.id === "skill")
      const subagentResult = results.find((part) => part.id === "subagent")

      expect(local?.result).toMatchObject({ type: "text" })
      expect(multi?.result).toMatchObject({ type: "text" })
      if (
        !local ||
        local.result.type !== "text" ||
        typeof local.result.value !== "string" ||
        !multi ||
        multi.result.type !== "text" ||
        typeof multi.result.value !== "string"
      )
        throw new Error("Expected projected pure-text tool results")
      expect(Array.from(local.result.value).slice(0, 4_096).join("")).toBe(Array.from(rebuilt).slice(0, 4_096).join(""))
      expect(Array.from(local.result.value).slice(-1_024).join("")).toBe(Array.from(rebuilt).slice(-1_024).join(""))
      expect(local.result.value.slice(0, "REBUILT-".length)).toBe("REBUILT-")
      expect(local.result.value).toEndWith("😀REBUIILT-TAIL")
      expect(local.result.value).toContain("characters trimmed for context.")
      const multiText = `${multiFirst}\n${multiLast}`
      expect(Array.from(multi.result.value).slice(0, 4_096).join("")).toBe(
        Array.from(multiText).slice(0, 4_096).join(""),
      )
      expect(Array.from(multi.result.value).slice(-1_024).join("")).toBe(Array.from(multiText).slice(-1_024).join(""))
      expect(multi.result.value.slice(0, "MULTI-FIRST-".length)).toBe("MULTI-FIRST-")
      expect(multi.result.value).toEndWith("😀MULTI-LAST")
      expect(hostedResult?.result).toMatchObject({ type: "text", value: hosted })
      expect(mixedResult?.result).toMatchObject({
        type: "content",
        value: [
          { type: "text", text: mixed },
          { type: "file", mime: "application/octet-stream" },
        ],
      })
      expect(skillResult?.result).toMatchObject({ type: "text", value: skill })
      expect(subagentResult?.result).toMatchObject({ type: "text" })
      if (!subagentResult || subagentResult.result.type !== "text" || typeof subagentResult.result.value !== "string")
        throw new Error("Expected projected untrusted subagent result")
      expect(Array.from(subagentResult.result.value).slice(0, 4_096).join("")).toBe(
        Array.from(subagent).slice(0, 4_096).join(""),
      )
      expect(Array.from(subagentResult.result.value).slice(-1_024).join("")).toBe(
        Array.from(subagent).slice(-1_024).join(""),
      )
      expect(subagentResult.result.value).toContain("characters trimmed for context.")
      expect(prepared.request.messages[0]).toEqual(remote)
      for (const result of results) expect(result.metadata?.[TOOL_RESULT_PRUNE_METADATA]).toBeUndefined()
    }),
  )

  pruneIt.effect("preserves only exact durable trusted subagent finals while stripping their provenance", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const input = requestInput(OpenAIResponses.route.model({ id: "gpt-5" }))
      const trusted = `TRUSTED-${"t".repeat(12_000)}😀TRUSTED-TAIL`
      const created = DateTime.makeUnsafe(0)
      const assistant = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_trusted_subagent"),
        type: "assistant",
        agent: input.scope.agentID,
        model: input.scope.model.ref,
        content: [
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "trusted-subagent",
            name: "subagent",
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: {},
              content: [{ type: "text", text: trusted }],
              metadata: {
                status: "completed",
                truncated: false,
                subagentFinal: true,
                sessionID: "ses_trusted_child",
              },
            }),
            time: { created, completed: created },
          }),
        ],
        time: { created, completed: created },
      })
      const transcript = SessionModelRequest.baseTranscript({
        agent: Agent.Info.default(input.scope.agentID),
        model: input.scope.model,
        tools: { definitions: [], execute: () => Effect.die("unused") },
        initial: "",
        messages: [assistant],
      })
      const prepared = yield* requests.prepare({
        ...input,
        transcript: { system: transcript.system, messages: transcript.messages },
        compactThreshold: 2_000,
      })
      const result = prepared.request.messages
        .flatMap((message) => message.content)
        .find(
          (
            part,
          ): part is Extract<(typeof prepared.request.messages)[number]["content"][number], { type: "tool-result" }> =>
            part.type === "tool-result" && part.id === "trusted-subagent",
        )

      if (!result || result.result.type !== "text" || typeof result.result.value !== "string")
        throw new Error("Expected trusted subagent final envelope")
      const envelope = JSON.parse(result.result.value) as { readonly sessionID: unknown; readonly output: unknown }
      expect(envelope.sessionID).toBe("ses_trusted_child")
      expect(envelope.output).toEqual([{ type: "text", text: trusted }])
      expect(result.result.value).not.toContain("characters trimmed for context.")
      expect(result.metadata).toBeUndefined()
    }),
  )

  it.effect("strips internal pruning metadata when pruning is disabled", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const marker = Symbol("private")
      const prepared = yield* requests.prepare({
        ...requestInput(OpenAIResponses.route.model({ id: "gpt-5" })),
        transcript: {
          system: [],
          messages: [
            Message.tool(
              ToolResultPart.make({
                id: "disabled",
                name: "read",
                result: { type: "text", value: "short result" },
                metadata: { [TOOL_RESULT_PRUNE_METADATA]: { marker } },
              }),
            ),
          ],
        },
      })
      const result = prepared.request.messages[0]?.content[0]
      expect(result).toMatchObject({ type: "tool-result", result: { type: "text", value: "short result" } })
      if (!result || result.type !== "tool-result") throw new Error("Expected tool result")
      expect(result.metadata?.[TOOL_RESULT_PRUNE_METADATA]).toBeUndefined()
    }),
  )

  pruneIt.effect("strips internal pruning metadata below the pressure gate", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const marker = Symbol("private")
      const prepared = yield* requests.prepare({
        ...requestInput(OpenAIResponses.route.model({ id: "gpt-5" })),
        transcript: {
          system: [],
          messages: [
            Message.tool(
              ToolResultPart.make({
                id: "below-gate",
                name: "read",
                result: { type: "text", value: "short result" },
                metadata: { [TOOL_RESULT_PRUNE_METADATA]: { marker } },
              }),
            ),
          ],
        },
        compactThreshold: 1_000_000,
      })
      const result = prepared.request.messages[0]?.content[0]
      expect(result).toMatchObject({ type: "tool-result", result: { type: "text", value: "short result" } })
      if (!result || result.type !== "tool-result") throw new Error("Expected tool result")
      expect(result.metadata?.[TOOL_RESULT_PRUNE_METADATA]).toBeUndefined()
    }),
  )
})
