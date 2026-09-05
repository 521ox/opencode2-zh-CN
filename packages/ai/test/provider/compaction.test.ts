import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, LLMEvent, LLMRequest } from "../../src/index.js"
import { compileRequest } from "../../src/route/client.js"
import { OpenAI, XAI } from "../../src/providers.js"
import { it, testEffect } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

it.effect("native OpenAI keeps in-band compaction without an explicit route operation", () =>
  Effect.gen(function* () {
    const request = LLM.request({
      model: OpenAI.configure({ apiKey: "test" }).responses("fixture"),
      prompt: "hello",
      providerOptions: { compactThreshold: 100_000 },
    })
    expect(LLMClient.canCompact(request)).toBe(false)
    const prepared = yield* compileRequest(request)
    expect(prepared.body.context_management).toEqual([{ type: "compaction", compact_threshold: 100_000 }])
  }),
)

it.effect("xAI forces stateless generation and rejects both in-band option spellings", () =>
  Effect.gen(function* () {
    const base = LLM.request({ model: XAI.configure({ apiKey: "test" }).responses("fixture"), prompt: "hello" })
    expect((yield* compileRequest(LLMRequest.update(base, { providerOptions: { store: true } }))).body.store).toBe(false)
    for (const providerOptions of [{ compactThreshold: 100_000 }, { contextManagement: [{ type: "compaction" }] }]) {
      const error = yield* compileRequest(LLMRequest.update(base, { providerOptions })).pipe(Effect.flip)
      expect(error.reason._tag).toBe("UnsupportedOperation")
      if (error.reason._tag === "UnsupportedOperation") expect(error.reason.operation).toBe("in-band-compaction")
    }
  }),
)

testEffect(
  fixedResponse(
    sseEvents(
      { type: "response.output_item.added", item: { type: "compaction", id: "cmp_native" } },
      {
        type: "response.output_item.done",
        item: { type: "compaction", id: "cmp_native", encrypted_content: "opaque" },
      },
      {
        type: "response.completed",
        response: { output: [{ type: "compaction", id: "cmp_native", encrypted_content: "opaque" }] },
      },
    ),
  ),
).effect("native terminal compaction remains a provider checkpoint", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(
      LLM.request({ model: OpenAI.configure({ apiKey: "test" }).responses("fixture"), prompt: "hello" }),
    )
    expect(response.events.filter(LLMEvent.is.compaction)).toEqual([])
    expect(response.events.filter(LLMEvent.is.providerCheckpoint)).toEqual([
      expect.objectContaining({ reset: true, item: expect.objectContaining({ id: "cmp_native" }) }),
    ])
  }),
)
