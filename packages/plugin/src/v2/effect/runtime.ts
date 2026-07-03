import type { SessionApi } from "@opencode-ai/client/effect/api"

export interface SessionHooks
  extends Pick<SessionApi<unknown>, "create" | "get" | "prompt" | "command" | "interrupt"> {}
