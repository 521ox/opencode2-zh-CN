import { describe, expect, test } from "bun:test"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/core/database/drizzle"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import sidecarMigration from "@opencode-ai/core/database/migration/20260829110336_session_assistant_sidecar"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Global } from "@opencode-ai/util/global"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const { id: _id, type: _type, content: _content, ...assistantHeadFields } = SessionMessage.Assistant.fields
const AssistantHead = Schema.Struct(assistantHeadFields)

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient | Global.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

function createLegacySchema(db: EffectDrizzleSqlite.EffectSQLiteDatabase) {
  return Effect.gen(function* () {
    yield* db.run(sql`PRAGMA foreign_keys = ON`)
    yield* db.run(sql`CREATE TABLE session_v2 (id text PRIMARY KEY)`)
    yield* db.run(sql`
      CREATE TABLE session_message (
        id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE,
        type text NOT NULL,
        seq integer NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      )
    `)
    yield* db.run(
      sql`CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`)`,
    )
    yield* db.run(
      sql`CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`)`,
    )
    yield* db.run(
      sql`CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`)`,
    )
    yield* db.run(sql`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`)`)
  })
}

function existingMessageState(db: EffectDrizzleSqlite.EffectSQLiteDatabase) {
  return Effect.gen(function* () {
    const table = yield* db.get(sql`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'session_message'
    `)
    const columns = yield* db.all(sql`
      SELECT name, type, "notnull", dflt_value, pk
      FROM pragma_table_info('session_message')
      ORDER BY cid
    `)
    const indexes = yield* db.all(sql`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'session_message'
      ORDER BY name
    `)
    const data = yield* db.all(sql`SELECT id, hex(data) AS data_hex FROM session_message ORDER BY id`)
    return { table, columns, indexes, data }
  })
}

function targetSchema(db: EffectDrizzleSqlite.EffectSQLiteDatabase) {
  return Effect.gen(function* () {
    const messageColumns = yield* db.all(sql`
      SELECT name, type, "notnull", dflt_value, pk
      FROM pragma_table_info('session_message')
      ORDER BY cid
    `)
    const activeColumns = yield* db.all(sql`
      SELECT name, type, "notnull", dflt_value, pk
      FROM pragma_table_info('session_assistant_active')
      ORDER BY cid
    `)
    const partColumns = yield* db.all(sql`
      SELECT name, type, "notnull", dflt_value, pk
      FROM pragma_table_info('session_assistant_part')
      ORDER BY cid
    `)
    const activeForeignKeys = yield* db.all(sql`
      SELECT "table", "from", "to", on_delete
      FROM pragma_foreign_key_list('session_assistant_active')
      ORDER BY id
    `)
    const partForeignKeys = yield* db.all(sql`
      SELECT "table", "from", "to", on_delete
      FROM pragma_foreign_key_list('session_assistant_part')
      ORDER BY id
    `)
    const indexes = yield* db.all(sql`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name IN ('session_message', 'session_assistant_active', 'session_assistant_part')
      ORDER BY name
    `)
    const activeTable = yield* db.get(sql`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'session_assistant_active'
    `)
    const partTable = yield* db.get(sql`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'session_assistant_part'
    `)
    return {
      messageColumns,
      activeColumns,
      partColumns,
      activeForeignKeys,
      partForeignKeys,
      indexes,
      activeTable,
      partTable,
    }
  })
}

function insertMessage(
  db: EffectDrizzleSqlite.EffectSQLiteDatabase,
  input: { id: string; sessionID: string; type: string; seq: number; data: string },
) {
  return db.run(sql`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (${input.id}, ${input.sessionID}, ${input.type}, ${input.seq}, 1, 1, ${input.data})
  `)
}

function insertPart(
  db: EffectDrizzleSqlite.EffectSQLiteDatabase,
  input: {
    messageID: string
    position: number
    type: string
    ordinal: number
    toolID?: string
    data?: string
  },
) {
  return db.run(sql`
    INSERT INTO session_assistant_part
      (message_id, position, type, type_ordinal, tool_id, data, time_created, time_updated)
    VALUES (
      ${input.messageID},
      ${input.position},
      ${input.type},
      ${input.ordinal},
      ${input.toolID ?? null},
      ${input.data ?? JSON.stringify({ type: input.type, text: "part" })},
      1,
      1
    )
  `)
}

function insertActive(
  db: EffectDrizzleSqlite.EffectSQLiteDatabase,
  input: { messageID: string; sessionID: string; data: string },
) {
  return db.run(sql`
    INSERT INTO session_assistant_active (message_id, session_id, data, time_created, time_updated)
    VALUES (${input.messageID}, ${input.sessionID}, ${input.data}, 1, 1)
  `)
}

describe("active assistant sidecar schema", () => {
  test("migrates metadata only, remains idempotent, and matches bootstrap schema", async () => {
    const largeSettled = JSON.stringify({
      agent: "build",
      model: { providerID: "test", modelID: "large" },
      content: [{ type: "text", text: "x".repeat(256 * 1024) }],
      time: { created: "2026-08-29T00:00:00.000Z", completed: "2026-08-29T00:00:01.000Z" },
    })
    const legacyActive = JSON.stringify({
      agent: "build",
      model: { providerID: "test", modelID: "legacy" },
      content: [{ type: "text", text: "still active" }],
      time: { created: "2026-08-29T00:00:00.000Z" },
    })

    const incremental = await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createLegacySchema(db)
        yield* db.run(sql`INSERT INTO session_v2 (id) VALUES ('session-a'), ('session-b')`)
        yield* insertMessage(db, {
          id: "settled",
          sessionID: "session-a",
          type: "assistant",
          seq: 1,
          data: largeSettled,
        })
        yield* insertMessage(db, {
          id: "legacy-active",
          sessionID: "session-a",
          type: "assistant",
          seq: 2,
          data: legacyActive,
        })
        yield* insertMessage(db, {
          id: "compaction",
          sessionID: "session-a",
          type: "compaction",
          seq: 3,
          data: JSON.stringify({ status: "completed", summary: "preserved" }),
        })
        yield* insertMessage(db, {
          id: "user",
          sessionID: "session-a",
          type: "user",
          seq: 4,
          data: JSON.stringify({ content: [{ type: "text", text: "question" }] }),
        })
        const before = yield* existingMessageState(db)

        yield* DatabaseMigration.applyOnly(db, [sidecarMigration])
        yield* DatabaseMigration.applyOnly(db, [sidecarMigration])

        expect(yield* existingMessageState(db)).toEqual(before)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM session_assistant_active`)).toEqual({ count: 0 })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM session_assistant_part`)).toEqual({ count: 0 })
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: sidecarMigration.id }])
        return yield* targetSchema(db)
      }),
    )

    const bootstrap = await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        return yield* targetSchema(db)
      }),
    )

    expect(incremental).toEqual(bootstrap)
  })

  test("enforces active head and part invariants in SQLite", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createLegacySchema(db)
        yield* db.run(sql`INSERT INTO session_v2 (id) VALUES ('session-a'), ('session-b')`)
        yield* insertMessage(db, {
          id: "assistant-a1",
          sessionID: "session-a",
          type: "assistant",
          seq: 1,
          data: "{}",
        })
        yield* insertMessage(db, {
          id: "assistant-a2",
          sessionID: "session-a",
          type: "assistant",
          seq: 2,
          data: "{}",
        })
        yield* insertMessage(db, {
          id: "assistant-b1",
          sessionID: "session-b",
          type: "assistant",
          seq: 1,
          data: "{}",
        })
        yield* DatabaseMigration.applyOnly(db, [sidecarMigration])

        expect(
          yield* db.all(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'index' AND name IN (
              'session_assistant_active_session_idx',
              'session_assistant_part_message_type_ordinal_idx',
              'session_assistant_part_message_type_position_idx',
              'session_assistant_part_message_tool_position_idx'
            )
            ORDER BY name
          `),
        ).toEqual([
          { name: "session_assistant_active_session_idx" },
          { name: "session_assistant_part_message_tool_position_idx" },
          { name: "session_assistant_part_message_type_ordinal_idx" },
          { name: "session_assistant_part_message_type_position_idx" },
        ])
        expect(
          (yield* db.get<{ sql: string }>(sql`
              SELECT sql
              FROM sqlite_master
              WHERE type = 'index' AND name = 'session_assistant_part_message_tool_position_idx'
            `))!.sql,
        ).toContain(`WHERE "session_assistant_part"."type" = 'tool'`)

        const headCodec = Schema.fromJsonString(AssistantHead)
        const head = Schema.decodeUnknownSync(headCodec)(
          JSON.stringify({
            agent: "build",
            model: { providerID: "test", id: "model" },
            time: { created: 1 },
          }),
        )
        const headData = Schema.encodeSync(headCodec)(head)
        yield* insertActive(db, { messageID: "assistant-a1", sessionID: "session-a", data: headData })
        expect(
          Schema.decodeUnknownSync(headCodec)(
            (yield* db.get<{ data: string }>(sql`
              SELECT data FROM session_assistant_active WHERE message_id = 'assistant-a1'
            `))!.data,
          ),
        ).toEqual(head)
        expect(
          (yield* Effect.exit(insertActive(db, { messageID: "assistant-a2", sessionID: "session-a", data: headData })))
            ._tag,
        ).toBe("Failure")
        expect(
          (yield* Effect.exit(insertActive(db, { messageID: "missing", sessionID: "session-b", data: headData })))._tag,
        ).toBe("Failure")
        expect(
          (yield* Effect.exit(insertActive(db, { messageID: "assistant-a2", sessionID: "missing", data: headData })))
            ._tag,
        ).toBe("Failure")
        yield* insertActive(db, { messageID: "assistant-b1", sessionID: "session-b", data: headData })
        expect(
          (yield* Effect.exit(insertActive(db, { messageID: "assistant-b1", sessionID: "session-a", data: headData })))
            ._tag,
        ).toBe("Failure")

        const text = { type: "text" as const, text: "owner schema roundtrip" }
        const codec = Schema.fromJsonString(SessionMessage.AssistantContent)
        const data = Schema.encodeSync(codec)(text)
        yield* insertPart(db, {
          messageID: "assistant-a1",
          position: 0,
          type: "text",
          ordinal: 0,
          data,
        })
        expect(
          Schema.decodeUnknownSync(codec)(
            (yield* db.get<{ data: string }>(sql`
              SELECT data FROM session_assistant_part
              WHERE message_id = 'assistant-a1' AND position = 0
            `))!.data,
          ),
        ).toEqual(text)

        expect(
          (yield* Effect.exit(
            insertPart(db, { messageID: "assistant-a1", position: 0, type: "reasoning", ordinal: 0 }),
          ))._tag,
        ).toBe("Failure")
        expect(
          (yield* Effect.exit(insertPart(db, { messageID: "assistant-a1", position: 1, type: "text", ordinal: 0 })))
            ._tag,
        ).toBe("Failure")
        expect(
          (yield* Effect.exit(insertPart(db, { messageID: "assistant-a1", position: -1, type: "text", ordinal: 1 })))
            ._tag,
        ).toBe("Failure")
        expect(
          (yield* Effect.exit(insertPart(db, { messageID: "assistant-a1", position: 1, type: "text", ordinal: -1 })))
            ._tag,
        ).toBe("Failure")
        expect(
          (yield* Effect.exit(insertPart(db, { messageID: "assistant-a1", position: 1, type: "image", ordinal: 1 })))
            ._tag,
        ).toBe("Failure")
        expect(
          (yield* Effect.exit(insertPart(db, { messageID: "assistant-a1", position: 1, type: "tool", ordinal: 0 })))
            ._tag,
        ).toBe("Failure")
        expect(
          (yield* Effect.exit(
            insertPart(db, {
              messageID: "assistant-a1",
              position: 1,
              type: "reasoning",
              ordinal: 0,
              toolID: "unexpected",
            }),
          ))._tag,
        ).toBe("Failure")
        expect(
          (yield* Effect.exit(insertPart(db, { messageID: "missing", position: 0, type: "text", ordinal: 0 })))._tag,
        ).toBe("Failure")

        yield* insertPart(db, {
          messageID: "assistant-a1",
          position: 1,
          type: "tool",
          ordinal: 0,
          toolID: "duplicate-tool-id",
          data: JSON.stringify({ type: "tool", id: "duplicate-tool-id" }),
        })
        yield* insertPart(db, {
          messageID: "assistant-a1",
          position: 2,
          type: "tool",
          ordinal: 1,
          toolID: "duplicate-tool-id",
          data: JSON.stringify({ type: "tool", id: "duplicate-tool-id" }),
        })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM session_assistant_part`)).toEqual({ count: 3 })

        yield* db.run(sql`DELETE FROM session_assistant_active WHERE message_id = 'assistant-a1'`)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM session_assistant_part`)).toEqual({ count: 0 })
        expect(yield* db.get(sql`SELECT id FROM session_message WHERE id = 'assistant-a1'`)).toEqual({
          id: "assistant-a1",
        })

        yield* insertActive(db, { messageID: "assistant-a1", sessionID: "session-a", data: headData })
        yield* insertPart(db, { messageID: "assistant-a1", position: 0, type: "text", ordinal: 0, data })
        yield* db.run(sql`DELETE FROM session_message WHERE id = 'assistant-a1'`)
        expect(
          yield* db.get(sql`SELECT message_id FROM session_assistant_active WHERE message_id = 'assistant-a1'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT count(*) AS count FROM session_assistant_part`)).toEqual({ count: 0 })

        yield* insertPart(db, {
          messageID: "assistant-b1",
          position: 0,
          type: "text",
          ordinal: 0,
          data,
        })
        yield* db.run(sql`DELETE FROM session_v2 WHERE id = 'session-b'`)
        expect(yield* db.get(sql`SELECT message_id FROM session_assistant_active`)).toBeUndefined()
        expect(yield* db.get(sql`SELECT message_id FROM session_assistant_part`)).toBeUndefined()
        expect(yield* db.get(sql`SELECT id FROM session_message WHERE id = 'assistant-b1'`)).toBeUndefined()
      }),
    )
  })

  test("rolls back the exact sidecar DDL and journal entry on migration failure", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createLegacySchema(db)
        const before = yield* existingMessageState(db)
        const failing = {
          id: "failing-sidecar",
          up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
            Effect.gen(function* () {
              yield* sidecarMigration.up(tx)
              yield* Effect.fail(new Error("stop after sidecar DDL"))
            }),
        }

        expect((yield* Effect.exit(DatabaseMigration.applyOnly(db, [failing])))._tag).toBe("Failure")
        expect(yield* existingMessageState(db)).toEqual(before)
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_assistant_active'`),
        ).toBeUndefined()
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_assistant_part'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = 'failing-sidecar'`)).toBeUndefined()
      }),
    )
  })
})
