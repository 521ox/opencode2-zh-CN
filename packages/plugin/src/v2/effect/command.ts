import type { CommandV2Info } from "@opencode-ai/sdk/v2/types"
import type { CommandApi } from "@opencode-ai/client/effect/api"
import type { Effect } from "effect"
import type { TransformHook } from "./registration.js"

export interface CommandDraft {
  list(): readonly CommandV2Info[]
  get(name: string): CommandV2Info | undefined
  update(name: string, update: (command: CommandV2Info) => void): void
  remove(name: string): void
}

export interface CommandHooks extends CommandApi<unknown> {
  readonly transform: TransformHook<CommandDraft>
  readonly reload: () => Effect.Effect<void>
}
