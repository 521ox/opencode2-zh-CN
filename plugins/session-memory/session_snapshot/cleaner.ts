import { canonicalJSON } from "./canonical"
import {
  inspectUnsupportedText,
  isSensitiveStructuredKey,
  maskCredentialFileToolOutput,
  redactText,
} from "./redaction"
import type {
  CleanMessage,
  CleanPart,
  CleaningBucket,
  CleaningStats,
  HydratedMessage,
  JsonObject,
  JsonValue,
  SessionSourceSnapshot,
} from "./types"

const OUTPUT_LIMIT = 16 * 1024
const SMALL_OUTPUT_LIMIT = 4 * 1024
const VALUE_LIMIT = 32 * 1024

type Decision = "kept" | "compressed" | "dropped"
type MutableStats = {
  partTypes: Map<string, CleaningBucket>
  tools: Map<string, CleaningBucket>
  retainedPayloadBytes: number
}

export type SessionCleanerInput = {
  messageRows: number
  partRows: number
  messageBytes: number
  partBytes: number
}

export type SessionCleaner = {
  clean(message: HydratedMessage): CleanMessage | null
  finish(input: SessionCleanerInput): {
    cleaning: CleaningStats
    maskRedaction: { redactedCount: number; categories: string[] }
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function jsonValue(value: unknown): JsonValue {
  return value as JsonValue
}

function byteLength(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value === "string") return Buffer.byteLength(value)
  return Buffer.byteLength(canonicalJSON(value))
}

function takePrefix(input: string, byteLimit: number): string {
  let bytes = 0
  let output = ""
  for (const char of input) {
    const width = Buffer.byteLength(char)
    if (bytes + width > byteLimit) break
    output += char
    bytes += width
  }
  return output
}

function takeSuffix(input: string, byteLimit: number): string {
  let bytes = 0
  const chars: string[] = []
  for (const char of [...input].reverse()) {
    const width = Buffer.byteLength(char)
    if (bytes + width > byteLimit) break
    chars.push(char)
    bytes += width
  }
  return chars.reverse().join("")
}

function boundedText(input: string, limit = OUTPUT_LIMIT): JsonValue {
  const originalBytes = Buffer.byteLength(input)
  if (originalBytes <= limit) return input
  const marker = `\n...[TRUNCATED ${originalBytes - limit} BYTES]...\n`
  const markerBytes = Buffer.byteLength(marker)
  const remaining = Math.max(0, limit - markerBytes)
  const headBytes = Math.ceil(remaining / 2)
  const tailBytes = Math.floor(remaining / 2)
  return {
    truncated: true,
    original_bytes: originalBytes,
    preview: `${takePrefix(input, headBytes)}${marker}${takeSuffix(input, tailBytes)}`,
  }
}

function compactValue(value: unknown, limit = VALUE_LIMIT): JsonValue {
  if (value === undefined) return null
  const serialized = canonicalJSON(value)
  if (Buffer.byteLength(serialized) <= limit) return jsonValue(value)
  return {
    truncated: true,
    original_bytes: Buffer.byteLength(serialized),
    preview: boundedText(serialized, limit),
  }
}

function omittedValue(value: unknown, reason: string): JsonValue {
  return { omitted: true, reason, original_bytes: byteLength(value) }
}

function binaryOmission(input: string): JsonValue | null {
  const inspection = inspectUnsupportedText(input)
  if (inspection.failureClasses.length === 0) return null
  return {
    omitted: true,
    reason: "binary-like-tool-content",
    original_bytes: Buffer.byteLength(input),
    failure_classes: inspection.failureClasses,
    nul_count: inspection.nulCount,
    control_count: inspection.controlCount,
  }
}

function sanitizeToolValue(value: unknown): JsonValue {
  if (value === null) return null
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") return binaryOmission(value) ?? value
  if (Array.isArray(value)) return value.map((item) => sanitizeToolValue(item))
  const object = objectValue(value)
  if (!object) return null
  const sanitized: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(object)) {
    const keyRedaction = redactText(key)
    if (
      isSensitiveStructuredKey(key) ||
      keyRedaction.status !== "eligible" ||
      keyRedaction.redactedCount > 0
    ) {
      return omittedValue(value, "unsupported-object-key")
    }
    sanitized[key] = sanitizeToolValue(item)
  }
  return sanitized
}

function boundedToolValue(value: unknown, limit: number): JsonValue {
  const sanitized = sanitizeToolValue(value)
  return typeof sanitized === "string" ? boundedText(sanitized, limit) : compactValue(sanitized, limit)
}

function selectedInput(value: unknown, keys: string[]): JsonValue {
  const input = objectValue(value)
  if (!input) return compactValue(sanitizeToolValue(value), SMALL_OUTPUT_LIMIT)
  const selected: Record<string, JsonValue> = {}
  for (const key of keys) {
    if (input[key] !== undefined) selected[key] = sanitizeToolValue(input[key])
  }
  return selected
}

function projectedMetadata(toolName: string, value: unknown): JsonValue | undefined {
  const metadata = objectValue(value)
  if (!metadata) return undefined

  if (toolName === "apply_patch") return undefined
  if (toolName === "read") return selectedInput(metadata, ["loaded", "truncated"])
  if (toolName === "bash" || toolName === "shell") {
    return selectedInput(metadata, ["exit", "exitCode", "interrupted", "truncated", "stdoutTruncated", "stderrTruncated", "outputPath"])
  }
  if (toolName === "grep") return selectedInput(metadata, ["matches", "truncated"])
  if (toolName === "glob") return selectedInput(metadata, ["count", "truncated"])

  return compactValue(sanitizeToolValue(metadata), 2 * 1024)
}

function patchOperations(value: unknown): JsonValue {
  const input = objectValue(value)
  const patchText = stringValue(input?.patchText) ?? ""
  const operations: Array<Record<string, JsonValue>> = []
  let current: Record<string, JsonValue> | null = null
  for (const line of patchText.split(/\r?\n/)) {
    const operation = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (operation) {
      current = { action: operation[1]!.toLowerCase(), path: operation[2]! }
      operations.push(current)
      continue
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/)
    if (move && current) current.move_to = move[1]!
  }
  return {
    patch_bytes: Buffer.byteLength(patchText),
    operation_count: operations.length,
    operations,
  }
}

function makeBucket(): CleaningBucket {
  return { kept: 0, compressed: 0, dropped: 0, input_bytes: 0, retained_bytes: 0 }
}

function recordBucket(map: Map<string, CleaningBucket>, key: string, decision: Decision, inputBytes: number, retainedBytes: number): void {
  const bucket = map.get(key) ?? makeBucket()
  bucket[decision]++
  bucket.input_bytes += inputBytes
  bucket.retained_bytes += retainedBytes
  map.set(key, bucket)
}

function cleanToolPart(
  id: string,
  data: JsonObject,
  lastTodo: { signature: string | null },
): { part: CleanPart | null; decision: Decision; tool: string; maskedCount: number; maskedCategories: string[] } {
  const masked = maskCredentialFileToolOutput(data)
  const value = objectValue(masked.value) ?? {}
  const toolName = stringValue(value.tool) ?? "unknown"
  const state = objectValue(value.state) ?? {}
  const input = state.input
  const output = state.output
  const error = state.error
  const projected = projectedMetadata(toolName, state.metadata)
  const metadata = projected === undefined ? undefined : sanitizeToolValue(projected)
  const base: CleanPart = {
    id,
    type: "tool",
    tool: toolName,
    ...(typeof value.callID === "string" ? { call_id: value.callID } : {}),
    ...(typeof state.status === "string" ? { status: state.status } : {}),
    ...(typeof state.title === "string" ? { title: state.title } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  }
  if (error !== undefined) base.error = compactValue(sanitizeToolValue(error), OUTPUT_LIMIT)

  if (toolName === "apply_patch") {
    base.input = sanitizeToolValue(patchOperations(input))
    if (output !== undefined) base.output = boundedToolValue(output, SMALL_OUTPUT_LIMIT)
  } else if (toolName === "read") {
    base.input = selectedInput(input, ["path", "filePath", "offset", "limit"])
    if (output !== undefined) base.output = omittedValue(output, "file-content-can-be-read-from-the-current-workspace")
  } else if (toolName === "skill") {
    base.input = selectedInput(input, ["name"])
    if (output !== undefined) base.output = omittedValue(output, "skill-body-is-not-session-continuity-evidence")
  } else if (toolName === "task" || toolName === "subagent" || toolName === "question") {
    if (input !== undefined) base.input = sanitizeToolValue(input)
    if (output !== undefined) base.output = sanitizeToolValue(output)
  } else if (toolName === "todowrite") {
    if (input !== undefined) base.input = sanitizeToolValue(input)
    if (output !== undefined) base.output = sanitizeToolValue(output)
    const signature = canonicalJSON({ input: base.input, output: base.output, status: base.status })
    if (signature === lastTodo.signature) {
      return { part: null, decision: "dropped", tool: toolName, maskedCount: masked.redactedCount, maskedCategories: masked.categories }
    }
    lastTodo.signature = signature
  } else if (["bash", "shell", "grep", "glob", "lsp", "web_search", "websearch", "webfetch"].includes(toolName)) {
    base.input = compactValue(sanitizeToolValue(input), VALUE_LIMIT)
    if (output !== undefined) base.output = boundedToolValue(output, OUTPUT_LIMIT)
  } else {
    base.input = compactValue(sanitizeToolValue(input), OUTPUT_LIMIT)
    if (output !== undefined) base.output = boundedToolValue(output, 8 * 1024)
  }
  return { part: base, decision: "compressed", tool: toolName, maskedCount: masked.redactedCount, maskedCategories: masked.categories }
}

function cleanMessage(
  message: HydratedMessage,
  stats: MutableStats,
  lastTodo: { signature: string | null },
  maskSummary: { redactedCount: number; categories: Set<string> },
): CleanMessage | null {
  const role = stringValue(message.data.role) ?? "unknown"
  const summary = message.data.summary === true
  const parts: CleanPart[] = []
  for (const sourcePart of message.parts) {
    const type = stringValue(sourcePart.data.type) ?? "unknown"
    const inputBytes = Buffer.byteLength(sourcePart.row.data)
    let decision: Decision = "dropped"
    let cleaned: CleanPart | null = null
    let toolName: string | null = null
    if (type === "text") {
      const text = stringValue(sourcePart.data.text)
      if (text !== null) {
        cleaned = { id: sourcePart.row.id, type: "text", text }
        decision = "kept"
      }
    } else if (type === "tool") {
      const tool = cleanToolPart(sourcePart.row.id, sourcePart.data, lastTodo)
      cleaned = tool.part
      decision = tool.decision
      toolName = tool.tool
      maskSummary.redactedCount += tool.maskedCount
      tool.maskedCategories.forEach((category) => maskSummary.categories.add(category))
    } else if (type === "compaction") {
      cleaned = { id: sourcePart.row.id, type: "compaction", data: sanitizeToolValue(sourcePart.data) }
      decision = "kept"
    } else if (type !== "reasoning" && type !== "step-start" && type !== "step-finish") {
      cleaned = { id: sourcePart.row.id, type, data: compactValue(sanitizeToolValue(sourcePart.data), 8 * 1024) }
      decision = "compressed"
    }
    const retainedBytes = cleaned ? Buffer.byteLength(canonicalJSON(cleaned)) : 0
    recordBucket(stats.partTypes, type, decision, inputBytes, retainedBytes)
    if (toolName) recordBucket(stats.tools, toolName, decision, inputBytes, retainedBytes)
    if (cleaned) {
      parts.push(cleaned)
      stats.retainedPayloadBytes += retainedBytes
    }
  }
  if (!parts.length && !summary && role !== "user") return null
  const model = message.data.model === undefined
    ? null
    : compactValue(sanitizeToolValue(message.data.model), SMALL_OUTPUT_LIMIT)
  return {
    id: message.row.id,
    time_created: message.row.time_created,
    time_updated: message.row.time_updated,
    role,
    summary,
    agent: stringValue(message.data.agent),
    model,
    parts,
  }
}

function sortedRecord(map: Map<string, CleaningBucket>): Record<string, CleaningBucket> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

export function createSessionCleaner(): SessionCleaner {
  const stats: MutableStats = { partTypes: new Map(), tools: new Map(), retainedPayloadBytes: 0 }
  const lastTodo = { signature: null as string | null }
  const maskSummary = { redactedCount: 0, categories: new Set<string>() }
  let retainedMessages = 0
  let retainedParts = 0
  return {
    clean(message) {
      const cleaned = cleanMessage(message, stats, lastTodo, maskSummary)
      if (cleaned) {
        retainedMessages++
        retainedParts += cleaned.parts.length
      }
      return cleaned
    },
    finish(input) {
      return {
        cleaning: {
          policy: "continuity-first-v1",
          input: {
            message_rows: input.messageRows,
            part_rows: input.partRows,
            message_bytes: input.messageBytes,
            part_bytes: input.partBytes,
            total_bytes: input.messageBytes + input.partBytes,
          },
          output: {
            messages: retainedMessages,
            parts: retainedParts,
            retained_payload_bytes: stats.retainedPayloadBytes,
          },
          part_types: sortedRecord(stats.partTypes),
          tools: sortedRecord(stats.tools),
        },
        maskRedaction: {
          redactedCount: maskSummary.redactedCount,
          categories: [...maskSummary.categories].sort(),
        },
      }
    },
  }
}

export function cleanSessionSource(source: SessionSourceSnapshot): {
  messages: CleanMessage[]
  cleaning: CleaningStats
  maskRedaction: { redactedCount: number; categories: string[] }
} {
  const cleaner = createSessionCleaner()
  const messages = source.messages
    .map((message) => cleaner.clean(message))
    .filter((message): message is CleanMessage => message !== null)
  const summary = cleaner.finish({
    messageRows: source.rawMessages.length,
    partRows: source.rawParts.length,
    messageBytes: source.messageRowBytes,
    partBytes: source.partRowBytes,
  })
  return {
    messages,
    cleaning: summary.cleaning,
    maskRedaction: summary.maskRedaction,
  }
}
