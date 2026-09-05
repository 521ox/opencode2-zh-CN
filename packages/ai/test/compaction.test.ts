import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  CompactionPart,
  CompactionResponse,
  LLM,
  LLMClient,
  LLMEvent,
  LLMRequest,
  LLMResponse,
  Message,
  ProviderID,
} from "../src/index.js"
import { Anthropic, OpenAI, OpenAICompatibleResponses, XAI } from "../src/providers.js"
import { testEffect } from "./lib/effect.js"
import { fixedResponse } from "./lib/http.js"

test("only the dedicated xAI Responses route exposes explicit compaction", () => {
  const xai = LLM.request({ model: XAI.model("fixture", {}), prompt: "hello" })
  const custom = LLM.request({ model: XAI.model("fixture", { baseURL: "https://proxy.example/v1" }), prompt: "hello" })
  expect(LLMClient.canCompact(xai)).toBe(true)
  expect(LLMClient.canCompact(custom)).toBe(true)

  for (const request of [
    LLM.request({ model: XAI.configure().chat("fixture") }),
    LLM.request({ model: OpenAI.configure().responses("fixture") }),
    LLM.request({ model: OpenAI.configure().chat("fixture") }),
    LLM.request({ model: Anthropic.configure().model("fixture") }),
    LLM.request({ model: OpenAICompatibleResponses.configure({ baseURL: "https://example.test/v1" }).model("fixture") }),
  ]) {
    expect(LLMClient.canCompact(request)).toBe(false)
  }
  expect(LLMClient.canCompact(LLMRequest.update(xai, { messages: [] }))).toBe(true)
})

test("compaction checkpoints remain typed opaque content", () => {
  const provider = ProviderID.make("xai")
  const checkpoint = CompactionPart.make({ provider, id: "cmp_1", encrypted: "opaque" })
  const response = new CompactionResponse({ replacement: [Message.assistant(checkpoint)] })
  const codec = Schema.fromJsonString(CompactionResponse)
  expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(response))).toEqual(response)

  const assembled = LLMResponse.fromEvents([checkpoint, LLMEvent.finish({ reason: { normalized: "stop" } })])!
  expect(assembled.message.content).toEqual([checkpoint])
  expect(assembled.text).toBe("")
  expect(assembled.events.filter(LLMEvent.is.compaction)).toEqual([checkpoint])
})

test("compaction requires exactly one opaque representation", () => {
  const provider = ProviderID.make("xai")
  const decode = Schema.decodeUnknownSync(CompactionPart)
  expect(() => decode({ type: "compaction", provider })).toThrow()
  expect(() => decode({ type: "compaction", provider, encrypted: "opaque", text: "summary" })).toThrow()
})

testEffect(fixedResponse("")).effect("unsupported explicit compaction is typed before network I/O", () =>
  Effect.gen(function* () {
    const request = LLM.request({ model: OpenAI.configure().responses("fixture"), prompt: "hello" })
    const error = yield* LLMClient.compact(request as unknown as Parameters<typeof LLMClient.compact>[0]).pipe(
      Effect.flip,
    )
    expect(error.reason._tag).toBe("UnsupportedOperation")
    if (error.reason._tag !== "UnsupportedOperation") return
    expect(error.reason.operation).toBe("compact")
    expect(error.reason.provider).toBe("openai")
    expect(error.reason.route).toBe("openai-responses")
  }),
)
