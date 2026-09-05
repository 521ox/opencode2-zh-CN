import { LLM, LLMClient, LLMRequest } from "../../src/index.js"
import { Anthropic, OpenAI, OpenAICompatibleResponses, XAI } from "../../src/providers.js"

const xai = LLM.request({ model: XAI.model("fixture", {}), prompt: "hello" })
LLMClient.compact(xai)
LLMClient.compact(LLMRequest.update(xai, { messages: [] }))
LLMClient.compact(
  LLM.request({ model: XAI.model("fixture", { baseURL: "https://proxy.example/v1" }), prompt: "hello" }),
)

const unsupported = [
  LLM.request({ model: XAI.configure().chat("fixture") }),
  LLM.request({ model: OpenAI.configure().responses("fixture") }),
  LLM.request({ model: OpenAI.configure().chat("fixture") }),
  LLM.request({ model: Anthropic.configure().model("fixture") }),
  LLM.request({ model: OpenAICompatibleResponses.configure({ baseURL: "https://example.test/v1" }).model("fixture") }),
]
for (const request of unsupported) {
  // @ts-expect-error Routes without the dedicated xAI operation cannot be explicitly compacted.
  LLMClient.compact(request)
}

XAI.configure({
  providerOptions: {
    // @ts-expect-error xAI does not support native in-band context management.
    compactThreshold: 100_000,
  },
})

declare const dynamic: Parameters<typeof LLM.request>[0]["model"]
const request = LLM.request({ model: dynamic })
// @ts-expect-error A dynamically selected route must be narrowed first.
LLMClient.compact(request)
if (LLMClient.canCompact(request)) LLMClient.compact(request)
