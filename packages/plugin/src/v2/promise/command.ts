import type { CommandApi } from "@opencode-ai/client/promise/api"
import type { CommandDraft } from "../effect/command.js"
import type { TransformHook } from "./registration.js"

export type { CommandDraft }

export interface CommandHooks extends CommandApi {
  readonly transform: TransformHook<CommandDraft>
  readonly reload: () => Promise<void>
}
