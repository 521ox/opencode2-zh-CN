import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, LLMEvent } from "../../src/index.js"
import { OpenAICompatibleResponses } from "../../src/providers.js"
import { testEffect } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

testEffect(
  fixedResponse(
    sseEvents(
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", call_id: "call_1", name: "lookup", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "provider-disagreed",
        delta: '{"query":"weather"}',
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"weather"}' },
      },
      { type: "response.completed", response: { id: "resp_1" } },
    ),
  ),
).effect("normalizes missing item ids once without replacing call-id stream identity", () =>
  Effect.gen(function* () {
    const model = OpenAICompatibleResponses.configure({
      apiKey: "test",
      baseURL: "https://example.test/v1",
    }).model("fixture")
    const response = yield* LLMClient.generate(LLM.request({ model, prompt: "hello" }))
    const call = response.events.find(LLMEvent.is.toolCall)
    expect(call).toMatchObject({ id: "call_1", name: "lookup", input: { query: "weather" } })
    expect(call?.providerMetadata?.["openai-compatible"]?.itemId).toMatch(/^fc_[0-9a-f]{32}$/)
    expect(response.events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
  }),
)
