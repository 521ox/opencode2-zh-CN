import { Route, type RouteRoutedLanguageModelInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Framing } from "../route/framing.js"
import { HttpTransport } from "../route/transport/index.js"
import * as ProviderShared from "./shared.js"
import { OpenResponses } from "./open-responses.js"

const ADAPTER = "openai-compatible-responses"

export type OpenAICompatibleResponsesLanguageModelInput = RouteRoutedLanguageModelInput

const finalizeBody = (body: Record<string, unknown>) => {
  const { context_management: _contextManagement, input, ...rest } = body
  return {
    ...rest,
    ...(input === undefined
      ? {}
      : {
          input: Array.isArray(input)
            ? input.filter((item) => !ProviderShared.isRecord(item) || item.type !== "compaction_trigger")
            : input,
        }),
    store: false,
  }
}

export const transport = HttpTransport.httpJson<OpenResponses.OpenResponsesBody, string>({
  framing: Framing.sse,
  finalizeBody,
})

/**
 * Deployment adapter for providers that expose an Open Responses-compatible
 * `/responses` endpoint. Provider helpers configure identity, endpoint, and
 * auth while the semantic protocol remains provider-neutral.
 */
export const route = Route.make({
  id: ADAPTER,
  providerMetadataKey: "openresponses",
  protocol: OpenResponses.protocol,
  endpoint: Endpoint.path(OpenResponses.PATH),
  transport,
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})

export * as OpenAICompatibleResponses from "./openai-compatible-responses.js"
