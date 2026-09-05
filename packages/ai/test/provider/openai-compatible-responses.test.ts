import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Headers, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMEvent, Message, ToolDefinition } from "../../src/index.js"
import { configure } from "../../src/providers/openai-compatible-responses.js"
import { OpenAI } from "../../src/providers.js"
import { OpenResponses } from "../../src/protocols/open-responses.js"
import { OpenAICompatibleResponses } from "../../src/protocols/openai-compatible-responses.js"
import { OpenAIResponses } from "../../src/protocols/openai-responses.js"
import { LLMClient } from "../../src/route.js"
import { Auth } from "../../src/route/auth.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

describe("Open Responses-compatible route", () => {
  it.effect("uses the Open Responses baseline for a configured deployment", () =>
    Effect.gen(function* () {
      expect(OpenAICompatibleResponses.route.body).toBe(OpenResponses.protocol.body)
      expect(OpenAICompatibleResponses.route.transport).toBe(OpenAICompatibleResponses.transport)
      expect(OpenAICompatibleResponses.route.transport).not.toBe(OpenAIResponses.transport)
      expect(OpenAICompatibleResponses.route.body).not.toBe(OpenAIResponses.protocol.body)

      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        provider: "example",
      }).model("example-model")
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          system: "You are concise.",
          prompt: "Say hello.",
        }),
      )

      expect(prepared.route).toBe("openai-compatible-responses")
      expect(prepared.protocol).toBe("open-responses")
      expect(prepared.model).toMatchObject({
        id: "example-model",
        provider: "example",
        route: {
          id: "openai-compatible-responses",
          endpoint: {
            baseURL: "https://responses.example.test/v1",
            path: "/responses",
          },
        },
      })
      expect(prepared.body).toEqual({
        model: "example-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        instructions: "You are concise.",
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      })
    }),
  )

  it.effect("forces stateless compatible bodies after every request overlay", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        provider: "example",
        providerOptions: { store: true, compactThreshold: 1, reasoningEffort: "low" },
        http: {
          body: {
            store: true,
            context_management: [{ type: "compaction", compact_threshold: 1 }],
            service_tier: "provider-tier",
          },
        },
      }).model("example-model")

      yield* LLMClient.generate(
        LLM.request({
          model,
          prompt: "Say hello.",
          providerOptions: { store: true, compactThreshold: 2, include: [] },
          http: {
            body: {
              store: true,
              context_management: [{ type: "compaction", compact_threshold: 2 }],
              input: [{ type: "compaction_trigger" }, { role: "user", content: "Retained" }],
              request_extension: true,
            },
          },
        }),
        { webSocket: { execute: () => Effect.die("Compatible Responses must not use native WebSocket") } },
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.sync(() => {
              const body = JSON.parse(input.text)
              expect(body).toMatchObject({
                store: false,
                reasoning: { effort: "low" },
                service_tier: "provider-tier",
                request_extension: true,
                input: [{ role: "user", content: "Retained" }],
              })
              expect(body.context_management).toBeUndefined()
              return input.respond(sseEvents({ type: "response.completed", response: { id: "resp_1" } }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("seals and reauthenticates every middleware dispatch", () =>
    Effect.gen(function* () {
      const authenticated: Array<{
        readonly method: string
        readonly url: string
        readonly body: string
        readonly headers: Headers.Headers
        readonly output: Headers.Headers
      }> = []
      const sent: string[] = []
      const model = configure({
        auth: Auth.custom((input) =>
          Effect.sync(() => {
            const output = Headers.set(
              Headers.remove(
                Headers.remove(Headers.remove(input.headers, "authorization"), "x-api-key"),
                "x-signature",
              ),
              "x-signature",
              `${input.method}:${input.url}:${input.body}`,
            )
            authenticated.push({
              method: input.method,
              url: input.url,
              body: input.body,
              headers: input.headers,
              output,
            })
            return output
          }),
        ),
        baseURL: "https://responses.example.test/v1",
        provider: "example",
      }).model("example-model")
      const candidate = (request: HttpClientRequest.HttpClientRequest, attempt: number) =>
        request.pipe(
          HttpClientRequest.setMethod(attempt === 1 ? "PUT" : "PATCH"),
          HttpClientRequest.setUrl(
            new URL(`https://proxy.example.test/responses?existing=base-${attempt}&repeat=base#base-hash`),
          ),
          HttpClientRequest.setUrlParam("attempt", String(attempt)),
          HttpClientRequest.setUrlParam("encoded", `value ${attempt} & more`),
          HttpClientRequest.appendUrlParam("repeat", "first"),
          HttpClientRequest.appendUrlParam("repeat", `retry ${attempt}/encoded`),
          HttpClientRequest.setHash(`dispatch-${attempt}`),
          HttpClientRequest.bodyText(
            JSON.stringify({
              store: true,
              context_management: [{ type: "compaction", compact_threshold: attempt }],
              input: [{ type: "compaction_trigger" }, { role: "user", content: `Attempt ${attempt}` }],
              attempt,
            }),
            "application/custom+json",
          ),
          HttpClientRequest.setHeader("authorization", "Bearer stale"),
          HttpClientRequest.setHeader("x-api-key", "stale-key"),
          HttpClientRequest.setHeader("x-signature", "stale-signature"),
          HttpClientRequest.setHeader("content-type", "application/stale+json"),
          HttpClientRequest.setHeader("content-length", "1"),
          HttpClientRequest.setHeader("x-middleware-attempt", String(attempt)),
        )

      yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" }), {
        http: (request, handler) =>
          Effect.gen(function* () {
            const first = yield* handler(candidate(request, 1))
            expect(first.status).toBe(429)
            return yield* handler(candidate(request, 2))
          }),
      }).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              const body = JSON.parse(input.text)
              const auth = authenticated.at(-1)
              if (!auth) throw new Error("Expected post-middleware authentication")
              sent.push(input.text)
              expect(auth.method).toBe(body.attempt === 1 ? "PUT" : "PATCH")
              expect(auth.url).toBe(request.url)
              const url = new URL(request.url)
              expect(url.searchParams.get("existing")).toBe(`base-${body.attempt}`)
              expect(url.searchParams.get("attempt")).toBe(String(body.attempt))
              expect(url.searchParams.get("encoded")).toBe(`value ${body.attempt} & more`)
              expect(url.searchParams.getAll("repeat")).toEqual(["base", "first", `retry ${body.attempt}/encoded`])
              expect(url.hash).toBe(`#dispatch-${body.attempt}`)
              expect(auth.body).toBe(input.text)
              expect(auth.headers["content-type"]).toBe("application/json")
              expect(auth.headers["content-length"]).toBe(String(new TextEncoder().encode(auth.body).byteLength))
              expect(auth.headers.authorization).toBe("Bearer stale")
              expect(auth.headers["x-api-key"]).toBe("stale-key")
              expect(auth.headers["x-signature"]).toBe("stale-signature")
              expect(input.request.headers).toEqual(auth.output)
              expect(request.method).toBe(auth.method)
              expect(request.url).toBe(auth.url)
              expect(request.headers.get("x-middleware-attempt")).toBe(String(body.attempt))
              expect(request.headers.get("content-type")).toBe(auth.output["content-type"])
              expect(request.headers.get("content-length")).toBe(auth.output["content-length"])
              expect(request.headers.get("authorization")).toBeNull()
              expect(request.headers.get("x-api-key")).toBeNull()
              expect(request.headers.get("x-signature")).toBe(auth.output["x-signature"])
              expect(body).toEqual({
                input: [{ role: "user", content: `Attempt ${body.attempt}` }],
                attempt: body.attempt,
                store: false,
              })
              return input.respond(sseEvents({ type: "response.completed", response: { id: "resp_1" } }), {
                status: sent.length === 1 ? 429 : 200,
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      )

      expect(sent).toHaveLength(2)
      expect(authenticated.slice(-2).map((item) => item.body)).toEqual(sent)
    }),
  )

  it.effect("rejects invalid middleware bodies before dispatch", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        provider: "example",
      }).model("example-model")
      const cases = [
        {
          name: "missing",
          message: "must provide a JSON body",
          candidate: (request: HttpClientRequest.HttpClientRequest) =>
            HttpClientRequest.post(request.url).pipe(HttpClientRequest.setHeaders(request.headers)),
        },
        {
          name: "malformed",
          message: "produced a malformed JSON body",
          candidate: (request: HttpClientRequest.HttpClientRequest) =>
            HttpClientRequest.bodyText(request, "not-json", "text/plain"),
        },
        {
          name: "non-record",
          message: "must provide a JSON object body",
          candidate: (request: HttpClientRequest.HttpClientRequest) =>
            HttpClientRequest.bodyText(request, "[]", "application/json"),
        },
      ]

      for (const item of cases) {
        let dispatched = false
        const error = yield* LLMClient.generate(LLM.request({ model, prompt: item.name }), {
          http: (request, handler) => handler(item.candidate(request)),
        }).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.sync(() => {
                dispatched = true
                return input.respond("must not dispatch")
              }),
            ),
          ),
          Effect.flip,
        )

        expect(error.reason._tag).toBe("InvalidRequest")
        expect(error.message).toContain(item.message)
        expect(dispatched).toBe(false)
      }
    }),
  )

  it.effect("lowers chronological system updates as standard developer messages", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        provider: "example",
      }).model("example-model")
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          system: "Initial instructions.",
          messages: [Message.user("Before."), Message.system("Operator update."), Message.assistant("After.")],
        }),
      )

      expect(prepared.body.instructions).toBe("Initial instructions.")
      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Before." }] },
        { role: "developer", content: "Operator update." },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "After." }] },
      ])
    }),
  )

  it.effect("uses data URLs for embedded PDF messages and tool results", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        provider: "example",
      }).model("example-model")
      const pdf = "data:application/pdf;base64,JVBERi0xLjQ="
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.user([{ type: "media", mediaType: "application/pdf", data: pdf, filename: "input.pdf" }]),
            Message.assistant({ type: "tool-call", id: "call_1", name: "read", input: {} }),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [{ type: "file", uri: pdf, mime: "application/pdf", name: "result.pdf" }],
            }),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_file", filename: "input.pdf", file_data: pdf }],
        },
        { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_file", filename: "result.pdf", file_data: pdf }],
        },
      ])
    }),
  )

  it.effect("rejects OpenAI-native tools", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
      }).model("example-model")
      const error = yield* compileRequest(
        LLM.request({ model, prompt: "Draw.", tools: [OpenAI.imageGeneration()] }),
      ).pipe(Effect.flip)

      expect(error.reason._tag).toBe("InvalidRequest")
      expect(error.message).toContain("Open Responses does not support provider-native tool image_generation")
    }),
  )

  it.effect("lowers canonical parallel tool control", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
      }).model("example-model")
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          prompt: "Read the file.",
          tools: [
            ToolDefinition.make({
              name: "read",
              description: "Read a file.",
              inputSchema: { type: "object" },
            }),
          ],
          toolChoice: { type: "auto", disableParallelToolUse: true },
        }),
      )

      expect(prepared.body.parallel_tool_calls).toBe(false)
      expect(prepared.body.tools).toEqual([
        {
          type: "function",
          name: "read",
          description: "Read a file.",
          parameters: { type: "object" },
          strict: false,
        },
      ])
    }),
  )

  it.effect("keeps foreign item id grammars but drops malformed ids", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
      }).model("example-model")
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "text", text: "Kept.", providerMetadata: { "openai-compatible": { itemId: "history_1" } } },
              {
                type: "text",
                text: "Long.",
                providerMetadata: { "openai-compatible": { itemId: `history_${"a".repeat(64)}` } },
              },
              {
                type: "text",
                text: "Opaque.",
                providerMetadata: { "openai-compatible": { itemId: "provider_value/with+symbols" } },
              },
              { type: "text", text: "No suffix.", providerMetadata: { "openai-compatible": { itemId: "msg_" } } },
              { type: "text", text: "No prefix.", providerMetadata: { "openai-compatible": { itemId: "_item" } } },
            ]),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          type: "message",
          id: "history_1",
          role: "assistant",
          content: [{ type: "output_text", text: "Kept." }],
        },
        {
          type: "message",
          id: `history_${"a".repeat(64)}`,
          role: "assistant",
          content: [{ type: "output_text", text: "Long." }],
        },
        {
          type: "message",
          id: "provider_value/with+symbols",
          role: "assistant",
          content: [{ type: "output_text", text: "Opaque." }],
        },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "No suffix." },
            { type: "output_text", text: "No prefix." },
          ],
        },
      ])
    }),
  )

  it.effect("replays only shared hosted tool items", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        provider: "example",
      }).model("example-model")
      const items = [
        { type: "web_search_call", id: "ws_1", status: "completed" },
        { type: "x_search_call", id: "x_search_1", status: "completed" },
        { type: "future_call", id: "future_1", status: "completed" },
        { type: "file_search_call", id: "fs_1", queries: "not-an-array" },
      ]
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: items.map((item) =>
            Message.assistant({
              type: "tool-result",
              id: item.id,
              name: item.type,
              result: { type: "json", value: item },
              providerExecuted: true,
              providerMetadata: { example: { itemId: item.id } },
            }),
          ),
        }),
      )

      expect(prepared.body.input).toEqual([
        items[0],
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(items[1]) }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(items[2]) }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(items[3]) }] },
      ])
    }),
  )

  it.effect("routes response deltas by output index", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
      }).model("example-model")
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", output_index: 2, item: { type: "message", id: "msg_1" } },
              { type: "response.output_text.delta", output_index: 2, item_id: "wrong_message", delta: "Indexed" },
              { type: "response.output_item.done", output_index: 2, item: { type: "message", id: "msg_1" } },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.message.content).toEqual([
        { type: "text", text: "Indexed", providerMetadata: { "openai-compatible": { itemId: "msg_1" } } },
      ])
    }),
  )

  describe("stream validation", () => {
    const request = LLM.request({
      model: configure({ apiKey: "test-key", baseURL: "https://responses.example.test/v1" }).model("example-model"),
      prompt: "Respond.",
    })

    const fixtures = [
      {
        item: { type: "message" },
        events: [
          { type: "response.output_text.delta", delta: "Preserved" },
          { type: "response.output_text.done", text: "Preserved" },
          { type: "response.refusal.delta", delta: "Preserved" },
          { type: "response.refusal.done", refusal: "Preserved" },
        ],
      },
      {
        item: { type: "reasoning", encrypted_content: "encrypted-state" },
        events: [
          { type: "response.reasoning.delta", delta: "Preserved" },
          { type: "response.reasoning.done", text: "Preserved" },
          { type: "response.reasoning_summary_text.delta", delta: "Preserved" },
          { type: "response.reasoning_summary_text.done", text: "Preserved" },
          { type: "response.reasoning_text.done", text: "Preserved" },
        ],
      },
      {
        item: { type: "function_call", call_id: "call_1", name: "lookup" },
        events: [
          { type: "response.function_call_arguments.delta", delta: '{"query":"Preserved"}' },
          { type: "response.function_call_arguments.done", arguments: '{"query":"Preserved"}' },
        ],
      },
    ]

    const routings = [
      { name: "empty item and event IDs", id: "", item_id: "" },
      { name: "empty event ID with registered index", id: "item_1", item_id: "", output_index: 2 },
      { name: "empty stored ID with registered index", id: "", item_id: "wrong_item", output_index: 2 },
      { name: "empty item and event IDs with registered index", id: "", item_id: "", output_index: 2 },
    ]

    fixtures.forEach((fixture) => {
      fixture.events.forEach((event) => {
        routings.forEach((routing) => {
          it.effect(`${event.type} preserves content with ${routing.name}`, () =>
            Effect.gen(function* () {
              const item = { ...fixture.item, id: routing.id }
              const response = yield* LLMClient.generate(request).pipe(
                Effect.provide(
                  fixedResponse(
                    sseEvents(
                      { type: "response.output_item.added", output_index: routing.output_index, item },
                      { ...event, item_id: routing.item_id, output_index: routing.output_index },
                      { type: "response.output_item.done", output_index: routing.output_index, item },
                      { type: "response.completed", response: { id: "resp_1" } },
                    ),
                  ),
                ),
              )

              const metadata = { "openai-compatible": { itemId: routing.id } }
              if (fixture.item.type === "function_call") {
                expect(response.toolCalls).toEqual([
                  expect.objectContaining({
                    id: "call_1",
                    name: "lookup",
                    input: { query: "Preserved" },
                    providerMetadata: metadata,
                  }),
                ])
                return
              }
              if (fixture.item.type === "reasoning") {
                expect(response.message.content).toEqual([
                  {
                    type: "reasoning",
                    text: "Preserved",
                    providerMetadata: {
                      "openai-compatible": { itemId: routing.id, reasoningEncryptedContent: "encrypted-state" },
                    },
                  },
                ])
                expect(response.events.filter(LLMEvent.is.reasoningEnd)).toHaveLength(1)
                return
              }
              expect(response.message.content).toEqual([
                { type: "text", text: "Preserved", providerMetadata: metadata },
              ])
              expect(response.events.filter(LLMEvent.is.textEnd)).toEqual([
                expect.objectContaining({ id: routing.id, providerMetadata: metadata }),
              ])
            }),
          )
        })
      })
    })

    routings.forEach((routing) => {
      it.effect(`preserves reasoning summary boundaries and terminal metadata with ${routing.name}`, () =>
        Effect.gen(function* () {
          const address = { item_id: routing.item_id, output_index: routing.output_index }
          const response = yield* LLMClient.generate(request).pipe(
            Effect.provide(
              fixedResponse(
                sseEvents(
                  {
                    type: "response.output_item.added",
                    output_index: routing.output_index,
                    item: { type: "reasoning", id: routing.id },
                  },
                  { type: "response.reasoning_summary_part.added", ...address, summary_index: 0 },
                  { type: "response.reasoning_summary_text.delta", ...address, summary_index: 0, delta: "First." },
                  { type: "response.reasoning_summary_text.done", ...address, summary_index: 0, text: "First." },
                  { type: "response.reasoning_summary_part.done", ...address, summary_index: 0 },
                  { type: "response.reasoning_summary_part.added", ...address, summary_index: 1 },
                  { type: "response.reasoning_summary_text.done", ...address, summary_index: 1, text: "Second." },
                  { type: "response.reasoning_summary_part.done", ...address, summary_index: 1 },
                  {
                    type: "response.completed",
                    response: { output: [{ type: "reasoning", id: routing.id, encrypted_content: "final-state" }] },
                  },
                ),
              ),
            ),
          )

          expect(response.message.content).toEqual([
            {
              type: "reasoning",
              text: "First.",
              providerMetadata: { "openai-compatible": { itemId: routing.id } },
            },
            {
              type: "reasoning",
              text: "Second.",
              providerMetadata: {
                "openai-compatible": { itemId: routing.id, reasoningEncryptedContent: "final-state" },
              },
            },
          ])
          expect(response.events.filter(LLMEvent.is.reasoningEnd)).toEqual([
            expect.objectContaining({
              id: `${routing.id}:0`,
              providerMetadata: { "openai-compatible": { itemId: routing.id } },
            }),
            expect.objectContaining({
              id: `${routing.id}:1`,
              providerMetadata: {
                "openai-compatible": { itemId: routing.id, reasoningEncryptedContent: "final-state" },
              },
            }),
          ])
        }),
      )
    })

    it.effect("reconciles pending empty-ID function arguments from completed output", () =>
      Effect.gen(function* () {
        const item = { type: "function_call", id: "", call_id: "call_1", name: "lookup" }
        const response = yield* LLMClient.generate(request).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                { type: "response.output_item.added", item },
                { type: "response.function_call_arguments.delta", item_id: "", delta: '{"query":"partial' },
                {
                  type: "response.completed",
                  response: { output: [{ ...item, arguments: '{"query":"complete"}' }] },
                },
              ),
            ),
          ),
        )

        expect(response.toolCalls).toEqual([
          expect.objectContaining({
            id: "call_1",
            name: "lookup",
            input: { query: "complete" },
            providerMetadata: { "openai-compatible": { itemId: "" } },
          }),
        ])
      }),
    )

    it.effect("treats null output items as no-ops without disturbing registered items", () =>
      Effect.gen(function* () {
        const response = yield* LLMClient.generate(request).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                { type: "response.output_item.added", output_index: 0, item: null },
                { type: "response.output_item.done", output_index: 0, item: null },
                { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
                { type: "response.output_text.delta", output_index: 0, item_id: "wrong_item", delta: "Before " },
                { type: "response.output_item.added", output_index: 0, item: null },
                { type: "response.output_item.done", output_index: 0, item: null },
                { type: "response.output_text.delta", output_index: 0, item_id: "wrong_item", delta: "after" },
                { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
                { type: "response.completed", response: { id: "resp_1" } },
              ),
            ),
          ),
        )

        expect(response.message.content).toEqual([
          { type: "text", text: "Before after", providerMetadata: { "openai-compatible": { itemId: "msg_1" } } },
        ])
        expect(response.events.map((event) => event.type)).toEqual([
          "step-start",
          "text-start",
          "text-delta",
          "text-delta",
          "text-end",
          "step-finish",
          "finish",
        ])
      }),
    )

    it.effect("rejects missing, null, and non-string event IDs even with a registered output index", () =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          [
            ...fixtures.flatMap((fixture) => fixture.events.map((event) => ({ item: fixture.item, event }))),
            ...["response.reasoning_summary_part.added", "response.reasoning_summary_part.done"].map((type) => ({
              item: { type: "reasoning" },
              event: { type, summary_index: 0 },
            })),
          ],
          (fixture) =>
            Effect.forEach([undefined, null, 0, false, {}, []], (item_id) =>
              Effect.gen(function* () {
                const error = yield* LLMClient.generate(request).pipe(
                  Effect.provide(
                    fixedResponse(
                      sseEvents(
                        {
                          type: "response.output_item.added",
                          output_index: 0,
                          item: { ...fixture.item, id: "item_1" },
                        },
                        { ...fixture.event, output_index: 0, item_id },
                        { type: "response.completed", response: { id: "resp_1" } },
                      ),
                    ),
                  ),
                  Effect.flip,
                )
                expect(error.reason._tag).toBe("InvalidProviderOutput")
              }),
            ),
        )
      }),
    )

    it.effect("keeps malformed output item IDs invalid", () =>
      Effect.gen(function* () {
        yield* Effect.forEach(["response.output_item.added", "response.output_item.done"], (type) =>
          Effect.forEach(fixtures, (fixture) =>
            Effect.forEach(
              [null, 0, false, {}, []],
              (id) =>
                Effect.gen(function* () {
                  const error = yield* LLMClient.generate(request).pipe(
                    Effect.provide(
                      fixedResponse(
                        sseEvents(
                          { type, item: { ...fixture.item, id } },
                          { type: "response.completed", response: { id: "resp_1" } },
                        ),
                      ),
                    ),
                    Effect.flip,
                  )
                  expect(error.reason._tag).toBe("InvalidProviderOutput")
                }),
            ),
          ),
        )
      }),
    )
  })

  it.effect("streams function calls without optional item ids through the shared baseline", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        provider: "example",
      }).model("example-model")
      const item = { type: "function_call", call_id: "call_1", name: "lookup", arguments: "" }
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Look it up." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", output_index: 1, item },
              {
                type: "response.function_call_arguments.delta",
                output_index: 1,
                item_id: "opaque_item",
                delta: '{"query":"shared"}',
              },
              {
                type: "response.output_item.done",
                output_index: 1,
                item: { ...item, arguments: '{"query":"complete"}' },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.filter(LLMEvent.is.toolCall)).toEqual([
        expect.objectContaining({ id: "call_1", name: "lookup", input: { query: "complete" } }),
      ])
      expect(response.events.find(LLMEvent.is.toolCall)?.providerMetadata?.example?.itemId).toMatch(
        /^fc_[0-9a-f]{32}$/,
      )
    }),
  )

  it.effect("finalizes pending function calls from completed response output", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        provider: "example",
      }).model("example-model")
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Look it up." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: "" },
              },
              { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"query":"par' },
              {
                type: "response.completed",
                response: {
                  output: [
                    {
                      type: "function_call",
                      id: "item_1",
                      call_id: "call_1",
                      name: "lookup",
                      arguments: '{"query":"complete"}',
                    },
                  ],
                },
              },
            ),
          ),
        ),
      )

      expect(response.events.find(LLMEvent.is.toolCall)).toMatchObject({
        input: { query: "complete" },
        providerMetadata: { example: { itemId: "item_1" } },
      })
    }),
  )

  it.effect("preserves terminal reasoning metadata when item completion is missing", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
      }).model("example-model")
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Think it through." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_raw", encrypted_content: null },
              },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_raw", delta: "Thinking" },
              {
                type: "response.completed",
                response: {
                  output: [{ type: "reasoning", id: "rs_raw", encrypted_content: "raw-state" }],
                },
              },
            ),
          ),
        ),
      )

      expect(response.events.find((event) => event.type === "reasoning-end")).toMatchObject({
        providerMetadata: { "openai-compatible": { itemId: "rs_raw", reasoningEncryptedContent: "raw-state" } },
      })
    }),
  )

  it.effect("reconciles raw reasoning finals without streamed deltas", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
      }).model("example-model")
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Think it through." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_raw", encrypted_content: null },
              },
              // Raw reasoning finals carry no summary index; they reconcile
              // into the item's first block.
              { type: "response.reasoning.done", item_id: "rs_raw", text: "Raw chain of thought." },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_raw", encrypted_content: "raw-state" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("Raw chain of thought.")
    }),
  )

  it.effect("preserves nullable phases in the forgiving Open Responses baseline", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
      }).model("example-model")
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: [
            Message.assistant({
              type: "text",
              text: "Unclassified.",
              providerMetadata: { "openai-compatible": { phase: null } },
            }),
          ],
        }),
      )

      expect(prepared.body).toMatchObject({
        input: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Unclassified." }],
            phase: null,
          },
        ],
      })
    }),
  )

  it.effect("preserves standard refusal content as ordinary assistant text", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        provider: "example",
      }).model("example-model")
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Unsafe request" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "msg_refusal", content: [] },
              },
              {
                type: "response.refusal.done",
                item_id: "msg_refusal",
                refusal: "I can't help with that.",
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "message",
                  id: "msg_refusal",
                  content: [{ type: "refusal", refusal: "I can't help with that." }],
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.message.content).toEqual([
        {
          type: "text",
          text: "I can't help with that.",
          providerMetadata: { example: { itemId: "msg_refusal" } },
        },
      ])

      const prepared = yield* compileRequest(LLM.request({ model, messages: [response.message] }))
      expect(prepared.body.input).toEqual([
        {
          type: "message",
          id: "msg_refusal",
          role: "assistant",
          content: [{ type: "output_text", text: "I can't help with that." }],
        },
      ])
    }),
  )

  it.effect("reads standard Open Responses options", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        providerOptions: {
          reasoningEffort: "low",
          store: true,
          metadata: { environment: "test" },
          safetyIdentifier: "user_123",
          streamOptions: { includeObfuscation: false },
          topLogprobs: 3,
          truncation: "auto",
          serviceTier: "fast",
          allowedTools: { toolNames: ["lookup"] },
          maxToolCalls: 2,
          parallelToolCalls: false,
        },
      }).model("example-model")
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          prompt: "Think.",
          generation: { presencePenalty: 0.2, frequencyPenalty: -0.1 },
          tools: [ToolDefinition.make({ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } })],
        }),
      )

      expect(prepared.body).toMatchObject({
        reasoning: { effort: "low" },
        store: true,
        metadata: { environment: "test" },
        safety_identifier: "user_123",
        stream_options: { include_obfuscation: false },
        top_logprobs: 3,
        presence_penalty: 0.2,
        frequency_penalty: -0.1,
        truncation: "auto",
        service_tier: "fast",
        tool_choice: {
          type: "allowed_tools",
          mode: "auto",
          tools: [{ type: "function", name: "lookup" }],
        },
        max_tool_calls: 2,
        parallel_tool_calls: false,
      })
    }),
  )

  it.effect("does not interpret OpenAI hosted-tool items", () =>
    Effect.gen(function* () {
      const model = configure({
        apiKey: "test-key",
        baseURL: "https://responses.example.test/v1",
        provider: "example",
      }).model("example-model")
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Search." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.done",
                item: { type: "web_search_call", id: "ws_1", status: "completed", action: { query: "news" } },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.toolCalls).toEqual([])
      expect(response.events.find(LLMEvent.is.finish)).toMatchObject({
        providerMetadata: { example: { responseId: "resp_1" } },
      })
    }),
  )
})
