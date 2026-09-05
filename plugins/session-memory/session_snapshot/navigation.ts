import type {
  CleanMessage,
  SessionSnapshotNavigationDocument,
  SnapshotTimeDivision,
  SnapshotMessageLine,
} from "./types"
import { canonicalCompactArrayItem } from "./stream"

const ROOT_SECTION_NAMES = ["snapshot", "session", "subagent_sessions", "messages"] as const
export const DIRECT_READ_MAX_LINES = 9_999

export function canReadSnapshotFromStart(totalLines: number): boolean {
  if (!Number.isSafeInteger(totalLines) || totalLines < 0) {
    navigationError(`invalid snapshot line count ${totalLines}`)
  }
  return totalLines <= DIRECT_READ_MAX_LINES
}

export type SnapshotFileIndex = {
  total_lines: number
  total_bytes: number
  sections: SessionSnapshotNavigationDocument["sections"]
  messages_start_line: number
  messages_end_line: number
  message_index: SnapshotMessageLine[]
}

/** Count trailing newline as terminator only (not an extra blank line). */
export function countTextLines(contents: string): number {
  if (contents.length === 0) return 0
  let lines = 1
  for (let i = 0; i < contents.length; i++) {
    if (contents.charCodeAt(i) === 10) lines++
  }
  if (contents.endsWith("\n")) lines--
  return lines
}

function navigationError(message: string): never {
  throw new Error(`Snapshot navigation indexing failed: ${message}`)
}

function itemAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index]
  if (value === undefined) navigationError(`${label} is missing`)
  return value
}

function dateFromEpochMs(time: number): Date {
  if (!Number.isSafeInteger(time) || time < 0) navigationError(`invalid non-negative epoch millisecond ${time}`)
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) navigationError(`epoch millisecond ${time} is outside the JavaScript Date range`)
  return date
}

function isoFromEpochMs(time: number): string {
  return dateFromEpochMs(time).toISOString()
}

/** UTC hour bucket, including extended ISO years when necessary. */
export function timeBucketKey(time: number): string {
  const date = dateFromEpochMs(time)
  const iso = date.toISOString()
  const separator = iso.indexOf("T")
  if (separator < 1) navigationError(`could not derive a UTC date from epoch millisecond ${time}`)
  return `${iso.slice(0, separator)}T${String(date.getUTCHours()).padStart(2, "0")}`
}

export function buildTimeDivisions(messageIndex: SnapshotMessageLine[]): SnapshotTimeDivision[] {
  if (messageIndex.length === 0) return []

  const divisions: SnapshotTimeDivision[] = []
  let currentKey = timeBucketKey(itemAt(messageIndex, 0, "message_index[0]").time_created)
  let start = 0

  const flush = (endInclusive: number) => {
    const first = itemAt(messageIndex, start, `message_index[${start}]`)
    const last = itemAt(messageIndex, endInclusive, `message_index[${endInclusive}]`)
    divisions.push({
      key: currentKey,
      start_time_iso: first.time_iso,
      end_time_iso: last.time_iso,
      start_line: first.line,
      end_line: last.end_line,
      message_count: endInclusive - start + 1,
      first_message_id: first.id,
      last_message_id: last.id,
    })
  }

  for (let i = 1; i < messageIndex.length; i++) {
    const key = timeBucketKey(itemAt(messageIndex, i, `message_index[${i}]`).time_created)
    if (key !== currentKey) {
      flush(i - 1)
      currentKey = key
      start = i
    }
  }
  flush(messageIndex.length - 1)
  return divisions
}

/**
 * Index a canonical schema v5 snapshot with one compact message per line.
 */
export function indexCanonicalSnapshot(contents: string, messages: CleanMessage[]): SnapshotFileIndex {
  if (!contents.endsWith("\n") || contents.endsWith("\n\n")) {
    navigationError("canonical snapshot must end with exactly one LF terminator")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    throw new Error("Snapshot navigation indexing failed: contents are not valid JSON", { cause: error })
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) navigationError("snapshot root is not an object")
  if ((parsed as Record<string, unknown>).schema_version !== 5) navigationError("snapshot schema version is not 5")
  const parsedMessages = (parsed as Record<string, unknown>).messages
  if (!Array.isArray(parsedMessages)) navigationError("root messages field is not an array")
  if (parsedMessages.length !== messages.length) {
    navigationError(`serialized message count ${parsedMessages.length} does not match retained count ${messages.length}`)
  }

  const total_bytes = Buffer.byteLength(contents, "utf8")
  const rawLines = contents.slice(0, -1).split("\n")
  const total_lines = rawLines.length
  if (itemAt(rawLines, rawLines.length - 1, "final snapshot line") !== "}") {
    navigationError("canonical snapshot root does not close on the final line")
  }

  const sections: SessionSnapshotNavigationDocument["sections"] = []
  let messages_start_line = 0
  let messages_end_line = 0

  for (const name of ROOT_SECTION_NAMES) {
    const prefix = `  "${name}":`
    const matches = rawLines.flatMap((line, index) => (line.startsWith(prefix) ? [index + 1] : []))
    if (matches.length > 1) navigationError(`root section ${name} appears more than once`)
    if (matches.length === 0) {
      navigationError(`root section ${name} is missing`)
    }
    sections.push({ name, start_line: itemAt(matches, 0, `root section ${name}`), end_line: total_lines - 1 })
  }
  sections.sort((a, b) => a.start_line - b.start_line)
  const expectedOrder = ROOT_SECTION_NAMES.filter((name) => sections.some((section) => section.name === name))
  if (sections.some((section, index) => section.name !== expectedOrder[index])) {
    navigationError("root sections are not in canonical order")
  }

  for (let s = 0; s < sections.length; s++) {
    const current = itemAt(sections, s, `sections[${s}]`)
    const next = sections[s + 1]
    current.end_line = next ? next.start_line - 1 : total_lines - 1
  }
  const messagesSection = sections.find((item) => item.name === "messages")
  if (!messagesSection) navigationError("root messages section is missing")
  messages_start_line = messagesSection.start_line
  messages_end_line = messagesSection.end_line

  const messagesStartIndex = messages_start_line - 1
  const messagesEndIndex = messages_end_line - 1
  const message_index: SnapshotMessageLine[] = []

  if (messages.length === 0) {
    if (
      itemAt(rawLines, messagesStartIndex, "messages section") !== '  "messages": []' ||
      messagesStartIndex !== messagesEndIndex
    ) {
      navigationError("empty messages array is not in canonical single-line form")
    }
  } else {
    if (
      itemAt(rawLines, messagesStartIndex, "messages section start") !== '  "messages": [' ||
      itemAt(rawLines, messagesEndIndex, "messages section end") !== "  ]"
    ) {
      navigationError("messages array boundaries are not in canonical form")
    }
    let cursor = messagesStartIndex + 1
    for (let index = 0; index < messages.length; index++) {
      const message = itemAt(messages, index, `retained messages[${index}]`)
      const expectedLine = `${canonicalCompactArrayItem(message)}${index === messages.length - 1 ? "" : ","}`
      const line = itemAt(rawLines, cursor, `messages[${index}] line`)
      if (line !== expectedLine) navigationError(`messages[${index}] is not canonical compact JSON`)
      let serialized: Record<string, unknown>
      try {
        serialized = JSON.parse(line.slice(4, index === messages.length - 1 ? undefined : -1)) as Record<string, unknown>
      } catch (error) {
        throw new Error(`Snapshot navigation indexing failed: messages[${index}] could not be parsed`, { cause: error })
      }
      const endIndex = cursor
      const id = serialized.id
      if (typeof id !== "string") navigationError(`messages[${index}].id is not a string`)
      if (id !== message.id) {
        navigationError(
          `messages[${index}].id ${JSON.stringify(id)} does not match retained message ${JSON.stringify(message.id)}`,
        )
      }
      const parsedID = (parsedMessages[index] as { id?: unknown } | undefined)?.id
      if (parsedID !== id) navigationError(`messages[${index}] line scan does not match parsed JSON`)
      message_index.push({
        index,
        line: cursor + 1,
        end_line: endIndex + 1,
        id,
        role: message.role,
        agent: message.agent,
        summary: message.summary,
        time_created: message.time_created,
        time_iso: isoFromEpochMs(message.time_created),
        part_count: message.parts.length,
      })
      cursor = endIndex + 1
    }
    if (cursor !== messagesEndIndex) navigationError("messages array contains unindexed content")
  }

  if (message_index.length !== messages.length) {
    navigationError(`indexed message count ${message_index.length} does not match retained count ${messages.length}`)
  }

  return {
    total_lines,
    total_bytes,
    sections,
    messages_start_line,
    messages_end_line,
    message_index,
  }
}

export function buildNavigation(input: {
  index: SnapshotFileIndex
  messages: CleanMessage[]
  sessionID: string
  snapshotCreatedAt: string
  snapshotSha256: string
}): SessionSnapshotNavigationDocument {
  const { index, messages } = input
  if (index.message_index.length !== messages.length) {
    navigationError(`indexed message count ${index.message_index.length} does not match retained count ${messages.length}`)
  }
  for (let position = 0; position < messages.length; position++) {
    const indexed = itemAt(index.message_index, position, `message_index[${position}]`)
    const message = itemAt(messages, position, `retained messages[${position}]`)
    if (
      indexed.index !== position ||
      indexed.id !== message.id ||
      indexed.line < 1 ||
      indexed.end_line < indexed.line
    ) {
      navigationError(`message_index[${position}] does not exactly identify retained message ${JSON.stringify(message.id)}`)
    }
  }

  const message_index = index.message_index
  const time_divisions = buildTimeDivisions(message_index)
  const first = message_index[0]
  const last = message_index[message_index.length - 1]

  return buildNavigationFromSummary({
    total_lines: index.total_lines,
    total_bytes: index.total_bytes,
    sections: index.sections,
    messages_start_line: index.messages_start_line,
    messages_end_line: index.messages_end_line,
    message_count: messages.length,
    time_span: first && last
      ? {
          start_time: first.time_created,
          end_time: last.time_created,
          start_time_iso: first.time_iso,
          end_time_iso: last.time_iso,
        }
      : null,
    time_divisions,
    sessionID: input.sessionID,
    snapshotCreatedAt: input.snapshotCreatedAt,
    snapshotSha256: input.snapshotSha256,
  })
}

export function buildNavigationFromSummary(input: {
  total_lines: number
  total_bytes: number
  sections: SessionSnapshotNavigationDocument["sections"]
  messages_start_line: number
  messages_end_line: number
  message_count: number
  time_span: SessionSnapshotNavigationDocument["time_span"]
  time_divisions: SnapshotTimeDivision[]
  sessionID: string
  snapshotCreatedAt: string
  snapshotSha256: string
}): SessionSnapshotNavigationDocument {
  return {
    schema_version: 1,
    snapshot_schema_version: 5,
    session_id: input.sessionID,
    snapshot_created_at: input.snapshotCreatedAt,
    snapshot_file: "snapshot.json",
    snapshot_sha256: input.snapshotSha256,
    total_lines: input.total_lines,
    total_bytes: input.total_bytes,
    direct_read_max_lines: DIRECT_READ_MAX_LINES,
    read_from_start_allowed: canReadSnapshotFromStart(input.total_lines),
    line_numbering: "1-based offsets into the sibling snapshot.json file",
    sections: input.sections,
    messages_start_line: input.messages_start_line,
    messages_end_line: input.messages_end_line,
    message_count: input.message_count,
    time_span: input.time_span,
    time_divisions: input.time_divisions,
  }
}
