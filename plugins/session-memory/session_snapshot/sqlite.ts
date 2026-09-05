import { Database } from "bun:sqlite"
import { Buffer } from "node:buffer"
import type {
  HydratedMessage,
  JsonObject,
  RawMessageRow,
  RawPartRow,
  RawSessionRow,
  SessionSourceStreamStats,
  SessionSourceStream,
} from "./types"
import { assertSessionID, type OpenCodePaths } from "./paths"

const MAX_MESSAGE_JSON_BYTES = 32 * 1024 * 1024

type SessionRow = {
  id: string
  project_id: string
  workspace_id: string | null
  parent_id: string | null
  directory: string
  path: string | null
  title: string | null
  version: string
  share_url: string | null
  summary_additions: number | null
  summary_deletions: number | null
  summary_files: number | null
  time_created: number
  time_updated: number
  time_compacting: number | null
  time_archived: number | null
  agent: string | null
  model: string | null
}

type MessageRow = {
  id: string
  session_id: string
  type: string
  seq: number
  time_created: number
  time_updated: number
  data: string
}

type SubagentRow = {
  id: string
  parent_id: string | null
  title: string | null
  time_updated: number
}

type CountRow = { count: number }
type DataVersionRow = { data_version: number }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseRecord(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} contains invalid JSON`, { cause: error })
  }
  const value = record(parsed)
  if (!value) throw new Error(`${label} must contain a JSON object`)
  return value
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function textValue(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function contentOutput(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined
  if (value.length === 1) {
    const item = record(value[0])
    if (item?.type === "text" && typeof item.text === "string") return item.text
  }
  return value
}

function projectToolPart(value: Record<string, unknown>): JsonObject {
  const state = record(value.state) ?? {}
  const status = textValue(state.status) ?? "unknown"
  const projectedState: JsonObject = { status }
  if (state.input !== undefined) projectedState.input = state.input as never
  const output = contentOutput(state.content)
  if (output !== undefined) projectedState.output = output as never
  if (state.error !== undefined) projectedState.error = state.error as never
  if (state.metadata !== undefined) projectedState.metadata = state.metadata as never
  return {
    type: "tool",
    tool: textValue(value.name) ?? "unknown",
    ...(typeof value.id === "string" ? { callID: value.id } : {}),
    state: projectedState,
  }
}

function projectContentPart(value: unknown): JsonObject | null {
  const item = record(value)
  if (!item) return null
  if (item.type === "tool") return projectToolPart(item)
  return item as JsonObject
}

function selected(value: Record<string, unknown>, keys: readonly string[]): JsonObject {
  const output: JsonObject = {}
  for (const key of keys) if (value[key] !== undefined) output[key] = value[key] as never
  return output
}

function projectMessage(row: MessageRow): HydratedMessage {
  const data = parseRecord(row.data, `session_message ${row.id}`)
  let role = "system"
  let summary = false
  let agent: string | null = null
  let model: unknown = null
  const parts: JsonObject[] = []

  if (row.type === "assistant") {
    role = "assistant"
    agent = textValue(data.agent)
    model = data.model ?? null
    if (Array.isArray(data.content)) {
      for (const item of data.content) {
        const part = projectContentPart(item)
        if (part) parts.push(part)
      }
    }
    const metadata = selected(data, ["error", "retry", "reason", "tokens", "cost"])
    if (Object.keys(metadata).length > 0) parts.push({ type: "assistant-metadata", ...metadata })
  } else if (row.type === "user") {
    role = "user"
    agent = textValue(data.agent)
    model = data.model ?? null
    if (typeof data.text === "string") parts.push({ type: "text", text: data.text })
    for (const key of ["files", "agents", "skills"] as const) {
      const values = data[key]
      if (!Array.isArray(values)) continue
      for (const item of values) {
        const part = projectContentPart(item)
        if (part) parts.push(part)
      }
    }
    const metadata = selected(data, ["variant", "system", "tools"])
    if (Object.keys(metadata).length > 0) parts.push({ type: "user-metadata", ...metadata })
  } else if (row.type === "synthetic" || row.type === "system") {
    if (typeof data.text === "string") parts.push({ type: "text", text: data.text })
  } else if (row.type === "skill") {
    if (typeof data.text === "string") parts.push({ type: "text", text: data.text })
    parts.push({ type: "skill", ...selected(data, ["name", "source"]) })
  } else if (row.type === "shell") {
    role = "assistant"
    const status = textValue(data.status) ?? "completed"
    const state: JsonObject = {
      status,
      input: { command: textValue(data.command) ?? "" },
      ...(data.output !== undefined ? { output: data.output as never } : {}),
      ...(typeof data.description === "string" ? { metadata: { description: data.description } } : {}),
    }
    parts.push({ type: "tool", tool: "shell", callID: row.id, state })
  } else if (row.type === "compaction") {
    role = "assistant"
    summary = true
    parts.push({ type: "compaction", ...data })
  } else {
    parts.push({ type: row.type, ...data })
  }

  const messageData: JsonObject = {
    role,
    summary,
    ...(agent ? { agent } : {}),
    ...(model === null ? {} : { model: model as never }),
  }
  const messageRow: RawMessageRow = {
    id: row.id,
    session_id: row.session_id,
    time_created: row.time_created,
    time_updated: row.time_updated,
    data: JSON.stringify(messageData),
  }
  const hydratedParts = parts.map((part, index) => {
    const partTime = record(part.time)
    const raw: RawPartRow = {
      id: typeof part.id === "string" ? part.id : `${row.id}:part:${index}`,
      message_id: row.id,
      session_id: row.session_id,
      time_created: numberValue(partTime?.start, row.time_created),
      time_updated: numberValue(partTime?.end, row.time_updated),
      data: JSON.stringify(part),
    }
    return { row: raw, data: part }
  })
  return { row: messageRow, data: messageData, parts: hydratedParts }
}

export function openReadOnlyDatabase(pathsOrDatabasePath: OpenCodePaths | string): Database {
  const databasePath = typeof pathsOrDatabasePath === "string" ? pathsOrDatabasePath : pathsOrDatabasePath.databasePath
  const db = new Database(databasePath, { readonly: true, create: false })
  db.exec("PRAGMA query_only = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  return db
}

function dataVersion(db: Database): number {
  const row = db.query<DataVersionRow, []>("PRAGMA data_version").get()
  if (!row || !Number.isFinite(row.data_version)) throw new Error("Unable to read SQLite data_version")
  return Number(row.data_version)
}

function readSession(db: Database, sessionID: string): RawSessionRow {
  const row = db
    .query<SessionRow, [string]>(
      `SELECT id, project_id, workspace_id, parent_id, directory, path, title, version, share_url,
              summary_additions, summary_deletions, summary_files, time_created, time_updated,
              time_compacting, time_archived, agent, model
         FROM session_v2
        WHERE id = ?`,
    )
    .get(sessionID)
  if (!row) throw new Error(`Trusted V2 session not found: ${sessionID}`)
  return {
    id: row.id,
    project_id: row.project_id,
    workspace_id: row.workspace_id,
    parent_id: row.parent_id,
    directory: row.directory,
    path: row.path,
    title: row.title ?? "Untitled",
    time_created: row.time_created,
    time_updated: row.time_updated,
    time_compacting: row.time_compacting,
    agent: row.agent,
    model: row.model,
  }
}

function readSubagents(db: Database, sessionID: string): SubagentRow[] {
  return db
    .query<SubagentRow, [string]>(
      `SELECT id, parent_id, title, time_updated
         FROM session_v2
        WHERE parent_id = ?
        ORDER BY time_updated ASC, id ASC`,
    )
    .all(sessionID)
}

function messageRows(db: Database, sessionID: string): IterableIterator<MessageRow> {
  return db
    .query<MessageRow, [string]>(
      `SELECT id, session_id, type, seq, time_created, time_updated, data
         FROM session_message
        WHERE session_id = ?
        ORDER BY seq ASC, id ASC`,
    )
    .iterate(sessionID)
}

export async function withSessionSourceStream<T>(
  paths: OpenCodePaths,
  trustedSessionID: string,
  callback: (stream: SessionSourceStream) => Promise<T>,
): Promise<{ value: T; source: SessionSourceStream }> {
  const sessionID = assertSessionID(trustedSessionID)
  const db = openReadOnlyDatabase(paths)
  const snapshotStartedAt = new Date().toISOString()
  let transactionOpen = false
  try {
    const initialDataVersion = dataVersion(db)
    db.run("BEGIN")
    transactionOpen = true
    const session = readSession(db, sessionID)
    const subagents = readSubagents(db, sessionID)
    const stats: SessionSourceStreamStats = {
      sourceMessageCount: 0,
      sourcePartCount: 0,
      messageRowBytes: 0,
      partRowBytes: 0,
      maxMessageTime: 0,
      maxPartTime: 0,
      compactionCount: 0,
      firstMessageID: null,
      lastMessageID: null,
    }
    let streamStarted = false
    let streamCompleted = false
    const source: SessionSourceStream = {
      session,
      subagentSessions: subagents.map((row) => ({ session_id: row.id, title: row.title ?? "Untitled" })),
      snapshotStartedAt,
      dataVersionBefore: initialDataVersion,
      dataVersionAfter: initialDataVersion,
      stats,
      *messages() {
        if (streamStarted) throw new Error(`V2 snapshot source can only be consumed once: ${sessionID}`)
        streamStarted = true
        let streamedSeq = -1
        for (const row of messageRows(db, sessionID)) {
          if (!Number.isInteger(row.seq) || row.seq <= streamedSeq) {
            throw new Error(`V2 session_message sequence changed while streaming at ${row.id}`)
          }
          streamedSeq = row.seq
          const messageBytes = Buffer.byteLength(row.data)
          if (messageBytes > MAX_MESSAGE_JSON_BYTES) {
            throw new Error(`V2 session_message ${row.id} exceeds the per-message snapshot source limit`)
          }
          const message = projectMessage(row)
          stats.sourceMessageCount++
          stats.messageRowBytes += messageBytes
          stats.maxMessageTime = Math.max(stats.maxMessageTime, row.time_created, row.time_updated)
          stats.firstMessageID ??= row.id
          stats.lastMessageID = row.id
          for (const part of message.parts) {
            stats.sourcePartCount++
            stats.partRowBytes += Buffer.byteLength(part.row.data)
            stats.maxPartTime = Math.max(stats.maxPartTime, part.row.time_created, part.row.time_updated)
          }
          if (row.type === "compaction") stats.compactionCount++
          yield message
        }
        streamCompleted = true
      },
    }
    const value = await callback(source)
    if (!streamStarted || !streamCompleted) throw new Error("V2 snapshot source was not fully consumed")
    const finalDataVersion = dataVersion(db)
    db.run("COMMIT")
    transactionOpen = false
    if (initialDataVersion !== finalDataVersion) {
      throw new Error("Session database changed while streaming the V2 snapshot")
    }
    source.dataVersionAfter = finalDataVersion
    return { value, source }
  } catch (error) {
    if (transactionOpen) {
      try {
        db.run("ROLLBACK")
      } catch {}
    }
    throw error
  } finally {
    db.close()
  }
}
