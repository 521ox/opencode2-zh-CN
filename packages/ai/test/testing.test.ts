import { expect } from "bun:test"
import { Effect } from "effect"
import { CompactionPart, CompactionResponse, LLM, Message, ProviderID } from "../src/index.js"
import { XAI } from "../src/providers.js"
import { TestLLM } from "../src/testing.js"
import { testEffect } from "./lib/effect.js"

testEffect(
  TestLLM.layer({
    fallback: new CompactionResponse({
      replacement: [
        Message.assistant(CompactionPart.make({ provider: ProviderID.make("xai"), encrypted: "checkpoint" })),
      ],
    }),
  }),
).effect("TestLLM scripts explicit compaction responses", () =>
  Effect.gen(function* () {
    const service = yield* TestLLM.Service
    const request = LLM.request({ model: XAI.configure().responses("fixture"), prompt: "hello" })
    const response = yield* service.client.compact!(request)
    expect(response.replacement[0]?.content[0]?.type).toBe("compaction")
    expect(service.requests).toEqual([request])
  }),
)
