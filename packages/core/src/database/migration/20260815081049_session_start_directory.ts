import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration.js"
import { SessionStartDirectory } from "../../session/start-directory.js"

function storedStartDirectory(input: unknown) {
  return SessionStartDirectory.storage(input)
}

function record(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "string") {
    try {
      return record(JSON.parse(input))
    } catch {
      return
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}

function createdDirectory(sessionID: string, input: unknown) {
  const data = record(input)
  if (!data || data.sessionID !== sessionID) return
  const location = record(data.location)
  if (location) return storedStartDirectory(location.directory)
  const info = record(data.info)
  if (!info || info.id !== sessionID) return
  return storedStartDirectory(info.directory)
}

const migration: DatabaseMigration.Migration = {
  id: "20260815081049_session_start_directory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`start_directory\` text;`)

      const legacyColumn = yield* tx.get<{ value: number }>(
        sql`SELECT 1 AS value FROM pragma_table_info('session') WHERE name = 'start_directory' LIMIT 1`,
      )
      if (legacyColumn) {
        const rows = yield* tx.all<{ id: string; start_directory: unknown }>(
          sql`SELECT id, start_directory FROM session WHERE start_directory IS NOT NULL`,
        )
        yield* Effect.forEach(rows, (row) => {
          const directory = storedStartDirectory(row.start_directory)
          if (!directory) return Effect.void
          return tx.run(
            sql`UPDATE session_v2 SET start_directory = ${directory} WHERE id = ${row.id} AND start_directory IS NULL`,
          )
        })
      }

      const eventTable = yield* tx.get<{ value: number }>(
        sql`SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'event' LIMIT 1`,
      )
      if (!eventTable) return
      const rows = yield* tx.all<{ id: string; data: unknown }>(sql`
        SELECT session_v2.id AS id, MIN(event.data) AS data
        FROM session_v2
        JOIN event ON event.aggregate_id = session_v2.id
        WHERE session_v2.start_directory IS NULL AND event.type = 'session.created.1'
        GROUP BY session_v2.id
        HAVING COUNT(*) = 1 AND MIN(event.seq) = 0 AND MAX(event.seq) = 0
      `)
      yield* Effect.forEach(rows, (row) => {
        const directory = createdDirectory(row.id, row.data)
        if (!directory) return Effect.void
        return tx.run(
          sql`UPDATE session_v2 SET start_directory = ${directory} WHERE id = ${row.id} AND start_directory IS NULL`,
        )
      })
    })
  },
}

export default migration
