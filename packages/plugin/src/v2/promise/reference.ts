import type { ReferenceApi } from "@opencode-ai/client/promise/api"
import type { ReferenceDraft } from "../effect/reference.js"
import type { TransformHook } from "./registration.js"

export type { ReferenceDraft }

export interface ReferenceHooks extends ReferenceApi {
  readonly transform: TransformHook<ReferenceDraft>
  readonly reload: () => Promise<void>
}
