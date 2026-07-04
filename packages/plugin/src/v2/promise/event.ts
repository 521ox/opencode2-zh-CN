import type { EventApi } from "@opencode-ai/client/promise/api"

export interface EventHooks extends Pick<EventApi, "subscribe"> {}
