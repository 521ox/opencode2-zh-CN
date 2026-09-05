import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { canonicalJSON, canonicalPrettyJSON } from "./canonical"
import { buildNavigation, indexCanonicalSnapshot, timeBucketKey } from "./navigation"
import { assertNoUnredactedSecretsInValue } from "./redaction"
import {
  canonicalCompactArrayItem,
  canonicalProperty,
  hashStreamFile,
  inspectStreamFile,
  type StreamFileSummary,
} from "./stream"
import type {
  CleaningBucket,
  CleanMessage,
  SessionSnapshotDocument,
  SessionSnapshotNavigationDocument,
  SnapshotTimeDivision,
} from "./types"

export const SNAPSHOT_ROOT_ORDER = ["schema_version", "snapshot", "session", "subagent_sessions", "messages"]
export const SNAPSHOT_NAVIGATION_ROOT_ORDER = [
  "schema_version",
  "snapshot_schema_version",
  "session_id",
  "snapshot_created_at",
  "snapshot_file",
  "snapshot_sha256",
  "total_lines",
  "total_bytes",
  "direct_read_max_lines",
  "read_from_start_allowed",
  "line_numbering",
  "sections",
  "messages_start_line",
  "messages_end_line",
  "message_count",
  "time_span",
  "time_divisions",
]

const SNAPSHOT_KEYS = [
  "session_id",
  "created_at",
  "source_message_count",
  "source_part_count",
  "retained_message_count",
  "retained_part_count",
  "compaction_count",
  "subagent_session_count",
  "first_message_id",
  "last_message_id",
  "max_message_time",
  "max_part_time",
  "data_version_before",
  "data_version_after",
  "redaction",
  "cleaning",
] as const
const REDACTION_KEYS = ["status", "redactedCount", "unknownCount", "categories", "failureClasses"] as const
const CLEANING_KEYS = ["policy", "input", "output", "part_types", "tools"] as const
const CLEANING_INPUT_KEYS = ["message_rows", "part_rows", "message_bytes", "part_bytes", "total_bytes"] as const
const CLEANING_OUTPUT_KEYS = ["messages", "parts", "retained_payload_bytes"] as const
const CLEANING_BUCKET_KEYS = ["kept", "compressed", "dropped", "input_bytes", "retained_bytes"] as const
const SESSION_KEYS = [
  "id",
  "project_id",
  "workspace_id",
  "parent_id",
  "directory",
  "path",
  "title",
  "agent",
  "model",
  "time_created",
  "time_updated",
  "time_compacting",
] as const
const SUBAGENT_KEYS = ["session_id", "title"] as const
const MESSAGE_KEYS = ["id", "time_created", "time_updated", "role", "summary", "agent", "model", "parts"] as const
const PART_REQUIRED_KEYS = ["id", "type"] as const
const PART_OPTIONAL_KEYS = ["tool", "call_id", "status", "title", "text", "data", "input", "output", "error", "metadata"] as const

type ObjectValue = Record<string, unknown>

export type SnapshotHeaderValidation = {
  sessionID: string
  retainedMessageCount: number
  retainedPartCount: number
  subagentSessionCount: number
}

export type SnapshotMessageValidation = {
  validate(messageValue: unknown): void
  finish(expectedMessageCount: number, expectedPartCount: number): void
}

export type StreamSnapshotValidation = {
  sessionID: string
  snapshotCreatedAt: string
  total_lines: number
  total_bytes: number
  snapshot_sha256: string
  sections: SessionSnapshotNavigationDocument["sections"]
  messages_start_line: number
  messages_end_line: number
  message_count: number
  time_span: SessionSnapshotNavigationDocument["time_span"]
  time_divisions: SnapshotTimeDivision[]
}

export type ConstructedSnapshotExpectation = Omit<StreamSnapshotValidation, "total_lines" | "total_bytes" | "snapshot_sha256"> & {
  file: StreamFileSummary
}

function invalid(label: string, expected: string): never {
  throw new Error(`Invalid session snapshot at ${label}: expected ${expected}`)
}

function objectValue(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label, "an object")
  return value as ObjectValue
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(label, "an array")
  return value
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(label, "a string")
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(label, "a boolean")
  return value
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(label, "a non-negative safe integer")
  }
  return value
}

function epochMillisecondValue(value: unknown, label: string): number {
  const time = integerValue(value, label)
  if (!Number.isFinite(new Date(time).getTime())) invalid(label, "a JavaScript-compatible epoch millisecond")
  return time
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  return stringValue(value, label)
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null) return null
  return integerValue(value, label)
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined) stringValue(value, label)
}

function requiredJsonProperty(value: ObjectValue, key: string, label: string): void {
  if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(label, "a required JSON value")
}

function exactObjectKeys(value: ObjectValue, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(label, `exact keys: ${wanted.join(", ")}`)
  }
}

function allowedObjectKeys(
  value: ObjectValue,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  const extra = keys.filter((key) => !allowed.has(key))
  if (missing.length > 0 || extra.length > 0) {
    invalid(
      label,
      `required keys ${required.join(", ")} and optional keys ${optional.join(", ")}`,
    )
  }
}

function stringArray(value: unknown, label: string): string[] {
  const result = arrayValue(value, label).map((item, index) => stringValue(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) invalid(label, "unique strings")
  return result
}

function bucket(value: unknown, label: string): CleaningBucket {
  const item = objectValue(value, label)
  exactObjectKeys(item, CLEANING_BUCKET_KEYS, label)
  return {
    kept: integerValue(item.kept, `${label}.kept`),
    compressed: integerValue(item.compressed, `${label}.compressed`),
    dropped: integerValue(item.dropped, `${label}.dropped`),
    input_bytes: integerValue(item.input_bytes, `${label}.input_bytes`),
    retained_bytes: integerValue(item.retained_bytes, `${label}.retained_bytes`),
  }
}

function bucketRecord(value: unknown, label: string): Record<string, CleaningBucket> {
  const record = objectValue(value, label)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, bucket(item, `${label}.${key}`)]))
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function compareSqliteBinaryText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

export function validateSnapshotHeader(snapshotValue: unknown): SnapshotHeaderValidation {
  const snapshot = objectValue(snapshotValue, "$.snapshot")
  exactObjectKeys(snapshot, SNAPSHOT_KEYS, "$.snapshot")
  const sessionID = stringValue(snapshot.session_id, "$.snapshot.session_id")
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionID)) invalid("$.snapshot.session_id", "a valid session ID")
  const createdAt = stringValue(snapshot.created_at, "$.snapshot.created_at")
  if (!Number.isFinite(Date.parse(createdAt))) invalid("$.snapshot.created_at", "an ISO timestamp")

  const sourceMessageCount = integerValue(snapshot.source_message_count, "$.snapshot.source_message_count")
  const sourcePartCount = integerValue(snapshot.source_part_count, "$.snapshot.source_part_count")
  const retainedMessageCount = integerValue(snapshot.retained_message_count, "$.snapshot.retained_message_count")
  const retainedPartCount = integerValue(snapshot.retained_part_count, "$.snapshot.retained_part_count")
  const compactionCount = integerValue(snapshot.compaction_count, "$.snapshot.compaction_count")
  const subagentSessionCount = integerValue(snapshot.subagent_session_count, "$.snapshot.subagent_session_count")
  nullableString(snapshot.first_message_id, "$.snapshot.first_message_id")
  nullableString(snapshot.last_message_id, "$.snapshot.last_message_id")
  epochMillisecondValue(snapshot.max_message_time, "$.snapshot.max_message_time")
  epochMillisecondValue(snapshot.max_part_time, "$.snapshot.max_part_time")
  integerValue(snapshot.data_version_before, "$.snapshot.data_version_before")
  integerValue(snapshot.data_version_after, "$.snapshot.data_version_after")
  if (retainedMessageCount > sourceMessageCount) invalid("$.snapshot.retained_message_count", "no more than source_message_count")
  if (retainedPartCount > sourcePartCount) invalid("$.snapshot.retained_part_count", "no more than source_part_count")
  if (compactionCount > sourceMessageCount) invalid("$.snapshot.compaction_count", "no more than source_message_count")

  const redaction = objectValue(snapshot.redaction, "$.snapshot.redaction")
  exactObjectKeys(redaction, REDACTION_KEYS, "$.snapshot.redaction")
  if (redaction.status !== "eligible") invalid("$.snapshot.redaction.status", "eligible")
  integerValue(redaction.redactedCount, "$.snapshot.redaction.redactedCount")
  if (integerValue(redaction.unknownCount, "$.snapshot.redaction.unknownCount") !== 0) {
    invalid("$.snapshot.redaction.unknownCount", "0")
  }
  stringArray(redaction.categories, "$.snapshot.redaction.categories")
  if (stringArray(redaction.failureClasses, "$.snapshot.redaction.failureClasses").length !== 0) {
    invalid("$.snapshot.redaction.failureClasses", "an empty array")
  }

  const cleaning = objectValue(snapshot.cleaning, "$.snapshot.cleaning")
  exactObjectKeys(cleaning, CLEANING_KEYS, "$.snapshot.cleaning")
  if (cleaning.policy !== "continuity-first-v1") invalid("$.snapshot.cleaning.policy", "continuity-first-v1")
  const cleaningInput = objectValue(cleaning.input, "$.snapshot.cleaning.input")
  exactObjectKeys(cleaningInput, CLEANING_INPUT_KEYS, "$.snapshot.cleaning.input")
  const inputMessageRows = integerValue(cleaningInput.message_rows, "$.snapshot.cleaning.input.message_rows")
  const inputPartRows = integerValue(cleaningInput.part_rows, "$.snapshot.cleaning.input.part_rows")
  const inputMessageBytes = integerValue(cleaningInput.message_bytes, "$.snapshot.cleaning.input.message_bytes")
  const inputPartBytes = integerValue(cleaningInput.part_bytes, "$.snapshot.cleaning.input.part_bytes")
  const inputTotalBytes = integerValue(cleaningInput.total_bytes, "$.snapshot.cleaning.input.total_bytes")
  if (inputMessageRows !== sourceMessageCount) invalid("$.snapshot.cleaning.input.message_rows", "source_message_count")
  if (inputPartRows !== sourcePartCount) invalid("$.snapshot.cleaning.input.part_rows", "source_part_count")
  if (inputTotalBytes !== inputMessageBytes + inputPartBytes) invalid("$.snapshot.cleaning.input.total_bytes", "message_bytes + part_bytes")

  const cleaningOutput = objectValue(cleaning.output, "$.snapshot.cleaning.output")
  exactObjectKeys(cleaningOutput, CLEANING_OUTPUT_KEYS, "$.snapshot.cleaning.output")
  const outputMessages = integerValue(cleaningOutput.messages, "$.snapshot.cleaning.output.messages")
  const outputParts = integerValue(cleaningOutput.parts, "$.snapshot.cleaning.output.parts")
  const retainedPayloadBytes = integerValue(cleaningOutput.retained_payload_bytes, "$.snapshot.cleaning.output.retained_payload_bytes")
  if (outputMessages !== retainedMessageCount) invalid("$.snapshot.cleaning.output.messages", "retained_message_count")
  if (outputParts !== retainedPartCount) invalid("$.snapshot.cleaning.output.parts", "retained_part_count")

  const partTypes = bucketRecord(cleaning.part_types, "$.snapshot.cleaning.part_types")
  bucketRecord(cleaning.tools, "$.snapshot.cleaning.tools")
  const partBuckets = Object.values(partTypes)
  if (sum(partBuckets.map((item) => item.kept + item.compressed + item.dropped)) !== sourcePartCount) {
    invalid("$.snapshot.cleaning.part_types", "counts totaling source_part_count")
  }
  if (sum(partBuckets.map((item) => item.kept + item.compressed)) !== retainedPartCount) {
    invalid("$.snapshot.cleaning.part_types", "retained counts totaling retained_part_count")
  }
  if (sum(partBuckets.map((item) => item.input_bytes)) !== inputPartBytes) {
    invalid("$.snapshot.cleaning.part_types", "input bytes totaling part_bytes")
  }
  if (sum(partBuckets.map((item) => item.retained_bytes)) !== retainedPayloadBytes) {
    invalid("$.snapshot.cleaning.part_types", "retained bytes totaling retained_payload_bytes")
  }
  return { sessionID, retainedMessageCount, retainedPartCount, subagentSessionCount }
}

export function validateSnapshotSession(sessionValue: unknown, sessionID: string): void {
  const session = objectValue(sessionValue, "$.session")
  exactObjectKeys(session, SESSION_KEYS, "$.session")
  if (stringValue(session.id, "$.session.id") !== sessionID) invalid("$.session.id", "snapshot.session_id")
  stringValue(session.project_id, "$.session.project_id")
  nullableString(session.workspace_id, "$.session.workspace_id")
  nullableString(session.parent_id, "$.session.parent_id")
  stringValue(session.directory, "$.session.directory")
  nullableString(session.path, "$.session.path")
  stringValue(session.title, "$.session.title")
  nullableString(session.agent, "$.session.agent")
  requiredJsonProperty(session, "model", "$.session.model")
  epochMillisecondValue(session.time_created, "$.session.time_created")
  epochMillisecondValue(session.time_updated, "$.session.time_updated")
  if (session.time_compacting !== null) epochMillisecondValue(session.time_compacting, "$.session.time_compacting")
}

export function validateSnapshotSubagents(
  subagentValue: unknown,
  sessionID: string,
  expectedCount: number,
): void {
  const subagentSessions = arrayValue(subagentValue, "$.subagent_sessions")
  const subagentSessionIDs = new Set<string>()
  for (const [index, value] of subagentSessions.entries()) {
    const label = `$.subagent_sessions[${index}]`
    const item = objectValue(value, label)
    exactObjectKeys(item, SUBAGENT_KEYS, label)
    const childSessionID = stringValue(item.session_id, `${label}.session_id`)
    if (!/^ses_[A-Za-z0-9_-]+$/.test(childSessionID)) invalid(`${label}.session_id`, "a valid session ID")
    if (childSessionID === sessionID) invalid(`${label}.session_id`, "a child session ID")
    if (subagentSessionIDs.has(childSessionID)) invalid(`${label}.session_id`, "a unique child session ID")
    subagentSessionIDs.add(childSessionID)
    stringValue(item.title, `${label}.title`)
  }
  if (subagentSessions.length !== expectedCount) {
    invalid("$.subagent_sessions", "snapshot.subagent_session_count entries")
  }
}

export function createSnapshotMessageValidation(): SnapshotMessageValidation {
  const messageIDs = new Set<string>()
  const partIDs = new Set<string>()
  let actualMessageCount = 0
  let actualPartCount = 0
  let previousMessage: { time: number; id: string } | null = null
  return {
    validate(messageValue) {
      const label = `$.messages[${actualMessageCount}]`
      const message = objectValue(messageValue, label)
      exactObjectKeys(message, MESSAGE_KEYS, label)
      const messageID = stringValue(message.id, `${label}.id`)
      if (messageIDs.has(messageID)) invalid(`${label}.id`, "a unique message ID")
      messageIDs.add(messageID)
      const timeCreated = epochMillisecondValue(message.time_created, `${label}.time_created`)
      epochMillisecondValue(message.time_updated, `${label}.time_updated`)
      stringValue(message.role, `${label}.role`)
      booleanValue(message.summary, `${label}.summary`)
      nullableString(message.agent, `${label}.agent`)
      requiredJsonProperty(message, "model", `${label}.model`)
      if (
        previousMessage &&
        (timeCreated < previousMessage.time ||
          (timeCreated === previousMessage.time && compareSqliteBinaryText(messageID, previousMessage.id) < 0))
      ) invalid(label, "chronological message ordering")
      previousMessage = { time: timeCreated, id: messageID }
      const parts = arrayValue(message.parts, `${label}.parts`)
      actualPartCount += parts.length
      for (const [partIndex, partValue] of parts.entries()) {
        const partLabel = `${label}.parts[${partIndex}]`
        const part = objectValue(partValue, partLabel)
        allowedObjectKeys(part, PART_REQUIRED_KEYS, PART_OPTIONAL_KEYS, partLabel)
        const partID = stringValue(part.id, `${partLabel}.id`)
        if (partIDs.has(partID)) invalid(`${partLabel}.id`, "a unique part ID")
        partIDs.add(partID)
        stringValue(part.type, `${partLabel}.type`)
        optionalString(part.tool, `${partLabel}.tool`)
        optionalString(part.call_id, `${partLabel}.call_id`)
        optionalString(part.status, `${partLabel}.status`)
        optionalString(part.title, `${partLabel}.title`)
        optionalString(part.text, `${partLabel}.text`)
      }
      actualMessageCount++
    },
    finish(expectedMessageCount, expectedPartCount) {
      if (actualMessageCount !== expectedMessageCount) invalid("$.messages", "retained_message_count entries")
      if (actualPartCount !== expectedPartCount) invalid("$.messages[*].parts", "retained_part_count entries")
    },
  }
}

function canonicalSnapshotDocumentV5(document: SessionSnapshotDocument): string {
  let output = '{\n  "schema_version": 5,\n'
  output += canonicalProperty("snapshot", document.snapshot, true)
  output += canonicalProperty("session", document.session, true)
  output += canonicalProperty("subagent_sessions", document.subagent_sessions, true)
  if (document.messages.length === 0) return `${output}  "messages": []\n}\n`
  return `${output}  "messages": [\n${document.messages.map(canonicalCompactArrayItem).join(",\n")}\n  ]\n}\n`
}

export function parseSessionSnapshotDocument(contents: string): SessionSnapshotDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    throw new Error("Session snapshot is not valid JSON", { cause: error })
  }

  const root = objectValue(parsed, "$")
  exactObjectKeys(root, SNAPSHOT_ROOT_ORDER, "$")
  if (root.schema_version !== 5) invalid("$.schema_version", "the literal 5")

  const header = validateSnapshotHeader(root.snapshot)
  validateSnapshotSession(root.session, header.sessionID)
  validateSnapshotSubagents(root.subagent_sessions, header.sessionID, header.subagentSessionCount)
  const messages = arrayValue(root.messages, "$.messages")
  const messageValidation = createSnapshotMessageValidation()
  messages.forEach((message) => messageValidation.validate(message))
  messageValidation.finish(header.retainedMessageCount, header.retainedPartCount)

  if (canonicalSnapshotDocumentV5(parsed as SessionSnapshotDocument) !== contents) {
    invalid("$", "canonical schema v5 JSON with one compact message per line and exactly one trailing LF")
  }

  return parsed as SessionSnapshotDocument
}

export function parseSessionSnapshotNavigationDocument(
  contents: string,
  snapshotContents: string,
): SessionSnapshotNavigationDocument {
  const snapshotDocument = parseSessionSnapshotDocument(snapshotContents)
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    throw new Error("Session snapshot navigation is not valid JSON", { cause: error })
  }
  const navigation = objectValue(parsed, "$")
  exactObjectKeys(navigation, SNAPSHOT_NAVIGATION_ROOT_ORDER, "$")
  if (canonicalPrettyJSON(parsed, SNAPSHOT_NAVIGATION_ROOT_ORDER) !== contents) {
    invalid("$", "canonical pretty-printed navigation JSON with exactly one trailing LF")
  }

  const snapshotSha256 = createHash("sha256").update(snapshotContents, "utf8").digest("hex")
  let expected: SessionSnapshotNavigationDocument
  try {
    expected = buildNavigation({
      index: indexCanonicalSnapshot(snapshotContents, snapshotDocument.messages as CleanMessage[]),
      messages: snapshotDocument.messages,
      sessionID: snapshotDocument.snapshot.session_id,
      snapshotCreatedAt: snapshotDocument.snapshot.created_at,
      snapshotSha256,
    })
  } catch (error) {
    throw new Error("Invalid session snapshot navigation: unable to index snapshot.json", { cause: error })
  }
  if (canonicalJSON(navigation) !== canonicalJSON(expected)) {
    invalid("$", "navigation exactly matching the sibling snapshot.json")
  }
  return parsed as SessionSnapshotNavigationDocument
}

export function parseSessionSnapshotNavigationAgainstExpected(
  contents: string,
  expected: SessionSnapshotNavigationDocument,
): SessionSnapshotNavigationDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    throw new Error("Session snapshot navigation is not valid JSON", { cause: error })
  }
  const navigation = objectValue(parsed, "$")
  exactObjectKeys(navigation, SNAPSHOT_NAVIGATION_ROOT_ORDER, "$")
  if (canonicalPrettyJSON(parsed, SNAPSHOT_NAVIGATION_ROOT_ORDER) !== contents) {
    invalid("$", "canonical pretty-printed navigation JSON with exactly one trailing LF")
  }
  if (canonicalJSON(navigation) !== canonicalJSON(expected)) {
    invalid("$", "navigation exactly matching the sibling snapshot.json")
  }
  return parsed as SessionSnapshotNavigationDocument
}

function parseCanonicalPropertyLines(lines: string[], name: string, trailingComma: boolean): unknown {
  const raw = `${lines.join("\n")}\n`
  const last = lines.at(-1)
  if (last === undefined) invalid(`$.${name}`, "a canonical property")
  const withoutComma = trailingComma
    ? [...lines.slice(0, -1), last.endsWith(",") ? last.slice(0, -1) : last]
    : lines
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(`{\n${withoutComma.join("\n")}\n}`) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Session snapshot property ${name} is not valid JSON`, { cause: error })
  }
  if (canonicalProperty(name, parsed[name], trailingComma) !== raw) {
    invalid(`$.${name}`, "canonical pretty-printed JSON")
  }
  return parsed[name]
}

export async function verifyConstructedSessionSnapshotFile(
  target: string,
  expected: ConstructedSnapshotExpectation,
): Promise<StreamSnapshotValidation> {
  const actual = await hashStreamFile(target)
  if (actual.sha256 !== expected.file.sha256) invalid("$", "SHA-256 matching the constructed byte stream")
  if (actual.total_bytes !== expected.file.total_bytes) invalid("$", "byte count matching the constructed byte stream")
  if (expected.file.carriage_return_count !== 0) invalid("$", "constructed LF line endings without carriage returns")
  if (expected.file.trailing_lf_count !== 1) invalid("$", "one constructed trailing LF")

  const expectedSections = ["snapshot", "session", "subagent_sessions", "messages"] as const
  if (expected.sections.length !== expectedSections.length) invalid("$.sections", "the four canonical root sections")
  for (let index = 0; index < expectedSections.length; index++) {
    const section = expected.sections[index]
    const name = expectedSections[index]
    if (!section || section.name !== name) invalid("$.sections", "canonical root section order")
    if (section.start_line < 3 || section.end_line < section.start_line) invalid(`$.sections[${index}]`, "a valid line range")
    const next = expected.sections[index + 1]
    if (next && section.end_line !== next.start_line - 1) invalid(`$.sections[${index}]`, "a contiguous line range")
  }

  if (expected.sections[0]?.start_line !== 3) invalid("$.sections[0]", "the canonical snapshot section start")
  const messagesSection = expected.sections[3]
  if (!messagesSection || messagesSection.start_line !== expected.messages_start_line) {
    invalid("$.messages_start_line", "the messages section start")
  }
  if (messagesSection.end_line !== expected.messages_end_line || messagesSection.end_line !== expected.file.total_lines - 1) {
    invalid("$.messages_end_line", "the messages section end immediately before the root close")
  }
  if (expected.message_count === 0) {
    if (expected.time_span !== null || expected.time_divisions.length !== 0) {
      invalid("$.time_span", "no timeline for an empty messages array")
    }
  } else if (expected.time_span === null || expected.time_divisions.length === 0) {
    invalid("$.time_span", "a timeline for retained messages")
  }
  let dividedMessages = 0
  let previousDivisionEnd = expected.messages_start_line
  for (const [index, division] of expected.time_divisions.entries()) {
    if (division.message_count < 1) invalid(`$.time_divisions[${index}]`, "at least one message")
    if (division.start_line <= previousDivisionEnd || division.end_line < division.start_line) {
      invalid(`$.time_divisions[${index}]`, "a forward non-overlapping line range")
    }
    if (division.end_line >= expected.messages_end_line) {
      invalid(`$.time_divisions[${index}]`, "a line range inside the messages array")
    }
    dividedMessages += division.message_count
    previousDivisionEnd = division.end_line
  }
  if (dividedMessages !== expected.message_count) invalid("$.time_divisions", "all retained messages exactly once")

  return {
    sessionID: expected.sessionID,
    snapshotCreatedAt: expected.snapshotCreatedAt,
    total_lines: expected.file.total_lines,
    total_bytes: actual.total_bytes,
    snapshot_sha256: actual.sha256,
    sections: expected.sections,
    messages_start_line: expected.messages_start_line,
    messages_end_line: expected.messages_end_line,
    message_count: expected.message_count,
    time_span: expected.time_span,
    time_divisions: expected.time_divisions,
  }
}

export async function validateSessionSnapshotFile(target: string): Promise<StreamSnapshotValidation> {
  const fileSummary = await inspectStreamFile(target)
  if (fileSummary.carriage_return_count !== 0) invalid("$", "LF line endings without carriage returns")
  if (fileSummary.trailing_lf_count !== 1) invalid("$", "exactly one trailing LF")

  const input = createReadStream(target, { encoding: "utf8", highWaterMark: 256 * 1024 })
  const lines = createInterface({ input, crlfDelay: Infinity })[Symbol.asyncIterator]()
  let lineNumber = 0
  const nextLine = async (): Promise<string | null> => {
    const next = await lines.next()
    if (next.done) return null
    lineNumber++
    return next.value
  }
  const requireLine = async (expected: string, label: string): Promise<void> => {
    const line = await nextLine()
    if (line !== expected) invalid(label, JSON.stringify(expected))
  }
  const collectProperty = async (
    name: string,
    trailingComma: boolean,
    closing: string,
  ): Promise<{ value: unknown; start: number; end: number }> => {
    const start = lineNumber + 1
    const first = await nextLine()
    if (first === null || !first.startsWith(`  ${JSON.stringify(name)}:`)) {
      invalid(`$.${name}`, "the next canonical root property")
    }
    const collected = [first]
    while (collected.at(-1) !== closing) {
      const line = await nextLine()
      if (line === null) invalid(`$.${name}`, `closing line ${JSON.stringify(closing)}`)
      collected.push(line)
    }
    return { value: parseCanonicalPropertyLines(collected, name, trailingComma), start, end: lineNumber }
  }

  try {
    await requireLine("{", "$")
    await requireLine('  "schema_version": 5,', "$.schema_version")
    const snapshotProperty = await collectProperty("snapshot", true, "  },")
    const header = validateSnapshotHeader(snapshotProperty.value)
    assertNoUnredactedSecretsInValue(snapshotProperty.value, "$.snapshot")
    const snapshotObject = objectValue(snapshotProperty.value, "$.snapshot")
    const snapshotCreatedAt = stringValue(snapshotObject.created_at, "$.snapshot.created_at")

    const sessionProperty = await collectProperty("session", true, "  },")
    validateSnapshotSession(sessionProperty.value, header.sessionID)
    assertNoUnredactedSecretsInValue(sessionProperty.value, "$.session")

    const subagentStart = lineNumber + 1
    const subagentFirst = await nextLine()
    if (subagentFirst === null || !subagentFirst.startsWith('  "subagent_sessions":')) {
      invalid("$.subagent_sessions", "the next canonical root property")
    }
    const subagentLines = [subagentFirst]
    if (subagentFirst !== '  "subagent_sessions": [],') {
      while (subagentLines.at(-1) !== "  ],") {
        const line = await nextLine()
        if (line === null) invalid("$.subagent_sessions", "closing line")
        subagentLines.push(line)
      }
    }
    const subagents = parseCanonicalPropertyLines(subagentLines, "subagent_sessions", true)
    validateSnapshotSubagents(subagents, header.sessionID, header.subagentSessionCount)
    assertNoUnredactedSecretsInValue(subagents, "$.subagent_sessions")
    const messagesStart = lineNumber + 1
    const messagesFirst = await nextLine()
    if (messagesFirst === null) invalid("$.messages", "the next canonical root property")
    const messageValidation = createSnapshotMessageValidation()
    const divisions: SnapshotTimeDivision[] = []
    let currentDivision: SnapshotTimeDivision | null = null
    let messageCount = 0
    let firstTime: number | null = null
    let lastTime: number | null = null
    let messagesEnd = lineNumber

    if (messagesFirst === '  "messages": []') {
      parseCanonicalPropertyLines([messagesFirst], "messages", false)
    } else {
      if (messagesFirst !== '  "messages": [') invalid("$.messages", "canonical messages array start")
      let requiresMessage = false
      while (true) {
        const startLine = lineNumber + 1
        const line = await nextLine()
        if (line === "  ]") {
          if (requiresMessage) invalid("$.messages", "a message after a trailing comma")
          invalid("$.messages", "the single-line canonical empty array")
        }
        if (line === null || !line.startsWith("    {") || (!line.endsWith("}") && !line.endsWith("},"))) {
          invalid(`$.messages[${messageCount}]`, "one canonical compact JSON object line")
        }
        const trailingComma = line.endsWith("},")
        const normalized = trailingComma ? line.slice(0, -1) : line
        let parsed: unknown
        try {
          parsed = JSON.parse(normalized.slice(4))
        } catch (error) {
          throw new Error(`Session snapshot validation failed at $.messages[${messageCount}]: invalid compact JSON`, {
            cause: error,
          })
        }
        if (canonicalCompactArrayItem(parsed) !== normalized) {
          invalid(`$.messages[${messageCount}]`, "canonical compact JSON")
        }
        messageValidation.validate(parsed)
        assertNoUnredactedSecretsInValue(parsed, `$.messages[${messageCount}]`)
        const message = objectValue(parsed, `$.messages[${messageCount}]`)
        const id = stringValue(message.id, `$.messages[${messageCount}].id`)
        const time = epochMillisecondValue(message.time_created, `$.messages[${messageCount}].time_created`)
        const timeIso = new Date(time).toISOString()
        const key = timeBucketKey(time)
        const existingDivision = currentDivision as SnapshotTimeDivision | null
        if (existingDivision === null || existingDivision.key !== key) {
          if (existingDivision) divisions.push(existingDivision)
          currentDivision = {
            key,
            start_time_iso: timeIso,
            end_time_iso: timeIso,
            start_line: startLine,
            end_line: startLine,
            message_count: 1,
            first_message_id: id,
            last_message_id: id,
          }
        } else {
          currentDivision = {
            ...existingDivision,
            end_time_iso: timeIso,
            end_line: startLine,
            message_count: existingDivision.message_count + 1,
            last_message_id: id,
          }
        }
        firstTime ??= time
        lastTime = time
        messageCount++
        if (trailingComma) {
          requiresMessage = true
          continue
        }
        requiresMessage = false
        const next = await nextLine()
        if (next !== "  ]") invalid("$.messages", "array close after the final message")
        messagesEnd = lineNumber
        break
      }
      if (currentDivision) divisions.push(currentDivision)
    }
    messageValidation.finish(header.retainedMessageCount, header.retainedPartCount)
    if (messageCount !== header.retainedMessageCount) invalid("$.messages", "retained_message_count entries")
    await requireLine("}", "$")
    if ((await nextLine()) !== null) invalid("$", "no content after the root close")
    if (lineNumber !== fileSummary.total_lines) invalid("$", "line count matching the file summary")

    return {
      sessionID: header.sessionID,
      snapshotCreatedAt,
      total_lines: fileSummary.total_lines,
      total_bytes: fileSummary.total_bytes,
      snapshot_sha256: fileSummary.sha256,
      sections: [
        { name: "snapshot", start_line: snapshotProperty.start, end_line: sessionProperty.start - 1 },
        { name: "session", start_line: sessionProperty.start, end_line: subagentStart - 1 },
        { name: "subagent_sessions", start_line: subagentStart, end_line: messagesStart - 1 },
        { name: "messages", start_line: messagesStart, end_line: messagesEnd },
      ],
      messages_start_line: messagesStart,
      messages_end_line: messagesEnd,
      message_count: messageCount,
      time_span: firstTime === null || lastTime === null
        ? null
        : {
            start_time: firstTime,
            end_time: lastTime,
            start_time_iso: new Date(firstTime).toISOString(),
            end_time_iso: new Date(lastTime).toISOString(),
          },
      time_divisions: divisions,
    }
  } finally {
    input.destroy()
  }
}
