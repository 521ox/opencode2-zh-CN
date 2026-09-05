import { LLM } from "../../src/index.js"
import { OpenAI } from "../../src/providers.js"

const selected = OpenAI.responses("gpt-5")
const chat = OpenAI.chat("gpt-4o-mini")

LLM.request({ model: selected, prompt: "Hello", providerOptions: { reasoningEffort: "high" } })
LLM.request({ model: selected, prompt: "Hello", providerOptions: { reasoningEffort: "experimental" } })
LLM.request({ model: selected, prompt: "Hello", providerOptions: { textVerbosity: "low" } })
LLM.request({ model: selected, prompt: "Hello", providerOptions: { textVerbosity: "verbose" } })
LLM.request({ model: selected, prompt: "Hello", providerOptions: { serviceTier: "auto" } })
LLM.request({ model: selected, prompt: "Hello", providerOptions: { serviceTier: "default" } })
LLM.request({ model: selected, prompt: "Hello", providerOptions: { serviceTier: "flex" } })
LLM.request({ model: selected, prompt: "Hello", providerOptions: { serviceTier: "priority" } })
LLM.request({ model: selected, prompt: "Hello", providerOptions: { serviceTier: "scale" } })
LLM.request({ model: selected, prompt: "Hello", providerOptions: { serviceTier: "fast" } })
LLM.request({ model: selected, prompt: "Hello", providerOptions: { serviceTier: "ultrafast" } })
LLM.request({
  model: selected,
  prompt: "Hello",
  // @ts-expect-error OpenAI service tiers are a closed provider contract.
  providerOptions: { serviceTier: "future-tier" },
})
LLM.request({ model: selected, prompt: "Hello", providerOptions: { compactThreshold: 120_000 } })
LLM.request({ model: chat, prompt: "Hello", providerOptions: { reasoningEffort: "max" } })
LLM.request({ model: chat, prompt: "Hello", providerOptions: { reasoningEffort: "experimental" } })

LLM.request({
  model: selected,
  prompt: "Hello",
  // @ts-expect-error OpenAI reasoning effort must be a string.
  providerOptions: { reasoningEffort: 1 },
})

LLM.request({
  model: selected,
  prompt: "Hello",
  // @ts-expect-error allowed tools only support auto and required modes.
  providerOptions: { allowedTools: { toolNames: ["read"], mode: "none" } },
})

OpenAI.configure({
  // @ts-expect-error Transport is execution policy, not provider configuration.
  transport: "websocket",
})
