import type { ReferenceGitSource, ReferenceLocalSource } from "@opencode-ai/sdk/v2/types"
import type { ReferenceApi } from "@opencode-ai/client/effect/api"
import type { Effect } from "effect"
import type { TransformHook } from "./registration.js"

export interface ReferenceDraft {
  add(name: string, source: ReferenceLocalSource | ReferenceGitSource): void
  remove(name: string): void
  list(): readonly (readonly [string, ReferenceLocalSource | ReferenceGitSource])[]
}

export interface ReferenceHooks extends ReferenceApi<unknown> {
  readonly transform: TransformHook<ReferenceDraft>
  readonly reload: () => Effect.Effect<void>
}
