import type { CatalogApi } from "@opencode-ai/client/promise/api"
import type { CatalogDraft, CatalogProviderRecord } from "../effect/catalog.js"
import type { TransformHook } from "./registration.js"

export type { CatalogDraft, CatalogProviderRecord }

export interface CatalogHooks extends CatalogApi {
  readonly transform: TransformHook<CatalogDraft>
  readonly reload: () => Promise<void>
}
