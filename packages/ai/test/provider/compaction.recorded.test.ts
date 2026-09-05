import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, LLMRequest, Message } from "../../src/index.js"
import { XAI } from "../../src/providers.js"
import { recordedTests } from "../recorded-test.js"

recordedTests({ prefix: "xai-compaction", provider: "xai", requires: ["XAI_API_KEY"] }).effect(
  "compacts and continues with the opaque xAI checkpoint",
  () =>
    Effect.gen(function* () {
      const model = XAI.configure({ apiKey: process.env.XAI_API_KEY ?? "fixture" }).responses("grok-4.6")
      const request = LLM.request({
        model,
        messages: [
          Message.user("Remember the project codename COPPER-ORBIT-42."),
          Message.assistant("We reviewed the implementation and tests. ".repeat(1000)),
        ],
        generation: { maxTokens: 1024 },
      })
      const compacted = yield* LLMClient.compact(request)
      expect(compacted.replacement.some((message) => message.content.some((part) => part.type === "compaction"))).toBe(
        true,
      )
      const response = yield* LLMClient.generate(
        LLMRequest.update(request, {
          messages: [
            ...compacted.replacement,
            Message.user("What is the project codename? Reply only with the codename."),
          ],
        }),
      )
      expect(response.text).toContain("COPPER-ORBIT-42")
    }),
  120_000,
)
