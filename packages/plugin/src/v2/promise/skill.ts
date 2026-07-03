import type { SkillApi } from "@opencode-ai/client/promise/api"
import type { SkillDraft } from "../effect/skill.js"
import type { TransformHook } from "./registration.js"

export type { SkillDraft }

export interface SkillHooks extends SkillApi {
  readonly transform: TransformHook<SkillDraft>
  readonly reload: () => Promise<void>
}
