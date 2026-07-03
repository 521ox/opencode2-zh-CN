import type { SessionApi } from "@opencode-ai/client/promise/api"

export interface SessionHooks extends Pick<SessionApi, "create" | "get" | "prompt" | "command" | "interrupt"> {}
