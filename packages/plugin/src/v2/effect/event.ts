import type { EventApi } from "@opencode-ai/client/effect/api"

export interface EventHooks extends Pick<EventApi<unknown>, "subscribe"> {}
