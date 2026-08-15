export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

export type OutputItem = {
  readonly [key: string]: Json
  readonly type: string
}

export type CompactionItem = OutputItem & {
  readonly encrypted_content: string
  readonly type: "compaction" | "compaction_summary"
}

export const isCompactionItem = (value: unknown): value is CompactionItem =>
  isJsonOutputItem(value) &&
  (value.type === "compaction" || value.type === "compaction_summary") &&
  typeof value.encrypted_content === "string" &&
  value.encrypted_content.length > 0

export const isRedactionMarker = (value: unknown) =>
  isJsonOutputItem(value) && value.type === "redacted" && value.reason === "opaque-remote-compaction"

export const isOutputItem = (value: unknown): value is OutputItem => {
  if (!isJsonOutputItem(value) || isRedactionMarker(value)) return false
  if (value.type === "compaction" || value.type === "compaction_summary") return isCompactionItem(value)
  return true
}

export const isOutput = (value: unknown): value is readonly OutputItem[] =>
  Array.isArray(value) && value.length > 0 && value.every(isOutputItem) && value.some(isCompactionItem)

function isJson(value: unknown, parents: Set<object>): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return false
  if (parents.has(value)) return false
  parents.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJson(item, parents))
    : isRecord(value) && Object.values(value).every((item) => isJson(item, parents))
  parents.delete(value)
  return valid
}

function isJsonOutputItem(value: unknown): value is OutputItem {
  return isRecord(value) && typeof value.type === "string" && isJson(value, new Set())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export * as OpenAICompaction from "./openai-compaction.js"
