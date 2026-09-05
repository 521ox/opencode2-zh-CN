import { assertNoUnredactedSecretsInValue, redactStructured } from "../session_snapshot/redaction"
import { openReadOnlyDatabase } from "../session_snapshot/sqlite"

export const DEFAULT_CATALOG_LIMIT = 50
export const MAX_CATALOG_LIMIT = 50
export const MAX_CATALOG_OUTPUT_BYTES = 7_500
export const MAX_CATALOG_TITLE_BYTES = 1_024

const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/

type CatalogCursor = {
  timeUpdated: number
  sessionID: string
}

type DecodedCursor =
  | { kind: "initial" }
  | { kind: "end" }
  | { kind: "page"; value: CatalogCursor }
  | { kind: "invalid" }

type CatalogRow = {
  id: string
  title: string | null
  time_updated: number
}

export type SessionCatalogEntry = {
  session_id: string
  title: string
}

export type SessionCatalogResult = {
  schema_version: 1
  root_session_count: number
  returned_session_count: number
  sessions: SessionCatalogEntry[]
  next_cursor: string | null
  redacted_count: number
  cursor_end?: true
  cursor_error?: {
    code: "invalid_cursor"
    message: string
    recovery: string
  }
}

function encodeCursor(row: CatalogRow): string {
  return Buffer.from(JSON.stringify([row.time_updated, row.id]), "utf8").toString("base64url")
}

function decodeCursor(value: unknown): DecodedCursor {
  if (value === undefined) return { kind: "initial" }
  if (value === null) return { kind: "end" }
  if (typeof value !== "string" || !CURSOR.test(value)) return { kind: "invalid" }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 2) return { kind: "invalid" }
    const [timeUpdated, sessionID] = parsed
    if (typeof timeUpdated !== "number" || !Number.isSafeInteger(timeUpdated) || timeUpdated < 0) {
      return { kind: "invalid" }
    }
    if (typeof sessionID !== "string" || !SESSION_ID.test(sessionID)) return { kind: "invalid" }
    return { kind: "page", value: { timeUpdated, sessionID } }
  } catch {
    return { kind: "invalid" }
  }
}

function assertLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_CATALOG_LIMIT
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_CATALOG_LIMIT) {
    throw new Error(`Session catalog limit must be an integer from 1 to ${MAX_CATALOG_LIMIT}`)
  }
  return value
}

function boundTitle(input: string): string {
  const originalBytes = Buffer.byteLength(input)
  if (originalBytes <= MAX_CATALOG_TITLE_BYTES) return input
  const suffix = `...[truncated ${originalBytes} bytes]`
  const prefixBudget = MAX_CATALOG_TITLE_BYTES - Buffer.byteLength(suffix)
  let low = 0
  let high = input.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(input.slice(0, middle)) <= prefixBudget) low = middle
    else high = middle - 1
  }
  if (
    low > 0 &&
    low < input.length &&
    input.charCodeAt(low - 1) >= 0xd800 &&
    input.charCodeAt(low - 1) <= 0xdbff &&
    input.charCodeAt(low) >= 0xdc00 &&
    input.charCodeAt(low) <= 0xdfff
  ) {
    low--
  }
  return input.slice(0, low) + suffix
}

export function loadSessionCatalog(
  databasePath: string,
  options: { currentSessionID: string; cursor?: unknown; limit?: unknown },
): SessionCatalogResult {
  if (!SESSION_ID.test(options.currentSessionID)) throw new Error("Invalid current session ID")
  const limit = assertLimit(options.limit)
  const decodedCursor = decodeCursor(options.cursor)
  const db = openReadOnlyDatabase(databasePath)
  let transactionOpen = false
  try {
    db.run("BEGIN")
    transactionOpen = true
    const rootSessionCount = Number(
      (
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM session_v2 WHERE parent_id IS NULL AND id <> ?",
          )
          .get(options.currentSessionID) as { count: number }
      ).count,
    )
    if (decodedCursor.kind === "end" || decodedCursor.kind === "invalid") {
      db.run("COMMIT")
      transactionOpen = false
      const result: SessionCatalogResult = {
        schema_version: 1,
        root_session_count: rootSessionCount,
        returned_session_count: 0,
        sessions: [],
        next_cursor: null,
        redacted_count: 0,
        ...(decodedCursor.kind === "end"
          ? { cursor_end: true as const }
          : {
              cursor_error: {
                code: "invalid_cursor" as const,
                message: "The supplied cursor is not a valid session_catalog cursor.",
                recovery:
                  "Do not retry the rejected cursor. Call session_catalog without cursor only if you intend to restart from the newest sessions.",
              },
            }),
      }
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_CATALOG_OUTPUT_BYTES) {
        throw new Error("Session catalog cursor result exceeds the byte boundary")
      }
      return result
    }
    const cursor = decodedCursor.kind === "page" ? decodedCursor.value : undefined
    const rows = cursor
      ? db
          .query<CatalogRow, [string, number, number, string, number]>(
            `SELECT id, title, time_updated
               FROM session_v2
              WHERE parent_id IS NULL
                AND id <> ?
                AND (time_updated < ? OR (time_updated = ? AND id < ?))
              ORDER BY time_updated DESC, id DESC
              LIMIT ?`,
          )
          .all(options.currentSessionID, cursor.timeUpdated, cursor.timeUpdated, cursor.sessionID, limit + 1)
      : db
          .query<CatalogRow, [string, number]>(
            `SELECT id, title, time_updated
               FROM session_v2
              WHERE parent_id IS NULL
                AND id <> ?
              ORDER BY time_updated DESC, id DESC
              LIMIT ?`,
          )
          .all(options.currentSessionID, limit + 1)
    db.run("COMMIT")
    transactionOpen = false

    const sessions: SessionCatalogEntry[] = []
    let redactedCount = 0
    let lastIncludedRow: CatalogRow | undefined
    for (const row of rows.slice(0, limit)) {
      if (!SESSION_ID.test(row.id)) throw new Error("Session catalog contains an invalid session ID")
      const redacted = redactStructured({ session_id: row.id, title: row.title ?? "Untitled" })
      if (redacted.status !== "eligible") {
        throw new Error(`Session catalog redaction is ${redacted.status}: ${redacted.failureClasses.join(", ")}`)
      }
      const entry = redacted.value as SessionCatalogEntry
      entry.title = boundTitle(entry.title)
      const candidateSessions = [...sessions, entry]
      const candidate: SessionCatalogResult = {
        schema_version: 1,
        root_session_count: rootSessionCount,
        returned_session_count: candidateSessions.length,
        sessions: candidateSessions,
        next_cursor: candidateSessions.length < rows.length ? encodeCursor(row) : null,
        redacted_count: redactedCount + redacted.redactedCount,
      }
      if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_CATALOG_OUTPUT_BYTES) {
        if (sessions.length === 0) throw new Error("A session catalog entry exceeds the output byte boundary")
        break
      }
      sessions.push(entry)
      redactedCount += redacted.redactedCount
      lastIncludedRow = row
    }

    const result: SessionCatalogResult = {
      schema_version: 1,
      root_session_count: rootSessionCount,
      returned_session_count: sessions.length,
      sessions,
      next_cursor: sessions.length < rows.length && lastIncludedRow ? encodeCursor(lastIncludedRow) : null,
      redacted_count: redactedCount,
    }
    assertNoUnredactedSecretsInValue(result.sessions, "session_catalog")
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_CATALOG_OUTPUT_BYTES) {
      throw new Error("Session catalog output exceeds the byte boundary")
    }
    return result
  } finally {
    if (transactionOpen) db.run("ROLLBACK")
    db.close()
  }
}
