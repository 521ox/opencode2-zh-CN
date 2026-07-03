import type { SkillV2Source } from "@opencode-ai/sdk/v2/types"
import type { SkillApi } from "@opencode-ai/client/effect/api"
import type { Effect } from "effect"
import type { TransformHook } from "./registration.js"

export interface SkillDraft {
  source(source: SkillV2Source): void
  list(): readonly SkillV2Source[]
}

export interface SkillHooks extends SkillApi<unknown> {
  readonly transform: TransformHook<SkillDraft>
  readonly reload: () => Effect.Effect<void>
}
