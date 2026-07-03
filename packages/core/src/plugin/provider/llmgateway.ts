import { Effect } from "effect"
import { define } from "../internal"
import { Integration } from "../../integration"

export const LLMGatewayPlugin = define({
  id: "llmgateway",
  effect: Effect.fn(function* (ctx) {
    const integrations = yield* Integration.Service
    const configured = new Set((yield* integrations.list()).map((integration) => integration.id))
    yield* ctx.catalog.transform((evt) => {
      for (const item of evt.provider.list()) {
        if (item.provider.disabled) continue
        if (item.provider.api.type !== "aisdk") continue
        if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
        if (item.provider.api.url !== "https://api.llmgateway.io/v1") continue
        if (!configured.has(Integration.ID.make(item.provider.id))) continue
        evt.provider.update(item.provider.id, (provider) => {
          provider.request.headers["HTTP-Referer"] = "https://opencode.ai/"
          provider.request.headers["X-Title"] = "opencode"
          provider.request.headers["X-Source"] = "opencode"
        })
      }
    })
  }),
})
