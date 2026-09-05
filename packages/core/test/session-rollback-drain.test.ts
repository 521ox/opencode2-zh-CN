import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Schema } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Model } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageProjection } from "@opencode-ai/core/session/message-projection"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import {
  SessionAssistantActiveTable,
  SessionAssistantPartTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
    [Bus.node, Bus.configured({ persist: true })],
  ]),
)
const model = Model.Ref.make({ id: Model.ID.make("drain"), providerID: Provider.ID.make("synthetic") })
const agent = Agent.ID.make("build")
const encodeAssistant = Schema.encodeSync(SessionMessage.Assistant)

describe("active assistant rollback drain", () => {
  it.effect("materializes every active assistant atomically and remains legacy-readable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* seedProject(db)
      const first = yield* seedActive(db, bus, "first", "running")
      const second = yield* seedActive(db, bus, "second", "streaming")
      const before = yield* Effect.forEach([first.messageID, second.messageID], (id) => active(db, id))
      yield* auditUpdates(db)

      expect(yield* SessionMessageProjection.checkActiveIntegrity(db)).toEqual({
        applicable: true,
        heads: 2,
        parts: 4,
        violations: [],
      })
      expect(yield* SessionMessageProjection.drainActive(db)).toEqual({ drained: 2, heads: 0, parts: 0 })
      expect(yield* db.$count(SessionAssistantActiveTable)).toBe(0)
      expect(yield* db.$count(SessionAssistantPartTable)).toBe(0)
      expect(yield* updateCounts(db)).toEqual([
        { id: first.messageID, writes: 1 },
        { id: second.messageID, writes: 1 },
      ])

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(sql`${SessionMessageTable.id} IN (${first.messageID}, ${second.messageID})`)
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const after = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(after.map((item) => encodeAssistant(item))).toEqual(
        before.toSorted((a, b) => a.id.localeCompare(b.id)).map((item) => encodeAssistant(item)),
      )
      for (const assistant of after) {
        expect(assistant.time.completed).toBeUndefined()
        const encoded = encodeAssistant(assistant) as Record<string, unknown>
        for (const key of ["finish", "cost", "tokens", "error"]) expect(encoded).not.toHaveProperty(key)
      }
      expect(yield* SessionMessageProjection.drainActive(db)).toEqual({ drained: 0, heads: 0, parts: 0 })

      const legacy = after[0]!
      const updated = { ...legacy, content: [...legacy.content, { type: "text" as const, text: "old-writer" }] }
      const encoded = encodeAssistant(updated)
      const { id, type, ...data } = encoded
      yield* db
        .update(SessionMessageTable)
        .set({ type, data })
        .where(eq(SessionMessageTable.id, SessionMessage.ID.make(id)))
        .run()
        .pipe(Effect.orDie)
      const legacyRow = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, SessionMessage.ID.make(id)))
        .get()
        .pipe(Effect.orDie)
      expect(
        Schema.decodeUnknownSync(SessionMessage.Assistant)({
          ...legacyRow!.data,
          id: legacyRow!.id,
          type: legacyRow!.type,
        }).content.at(-1),
      ).toEqual({ type: "text", text: "old-writer" })
    }),
  )

  it.effect("rolls back all candidate updates when a later anchor update aborts", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* seedProject(db)
      yield* seedActive(db, bus, "rollback-a", "running")
      yield* seedActive(db, bus, "rollback-b", "streaming")
      const before = yield* snapshot(db)
      yield* db.run(sql`CREATE TEMP TABLE drain_abort_counter (value INTEGER NOT NULL)`)
      yield* db.run(sql`
        CREATE TEMP TRIGGER drain_count_update
        AFTER UPDATE OF data ON session_message
        BEGIN
          INSERT INTO drain_abort_counter(value) VALUES (1);
        END
      `)
      yield* db.run(sql`
        CREATE TEMP TRIGGER drain_abort_second_update
        BEFORE UPDATE OF data ON session_message
        WHEN (SELECT count(*) FROM drain_abort_counter) >= 1
        BEGIN
          SELECT RAISE(ABORT, 'injected drain failure');
        END
      `)

      const exit = yield* SessionMessageProjection.drainActive(db).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* snapshot(db)).toEqual(before)
      expect(yield* db.$count(SessionAssistantActiveTable)).toBe(2)
      expect(yield* db.$count(SessionAssistantPartTable)).toBe(4)
    }),
  )

  it.effect("fails closed when an old writer replaces an active anchor", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* seedProject(db)
      const fixture = yield* seedActive(db, bus, "old-writer", "running")
      const before = yield* snapshot(db)
      const anchor = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, fixture.messageID))
        .get()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionMessageTable)
        .set({ data: { ...anchor!.data, content: [{ type: "text", text: "old" }] } })
        .where(eq(SessionMessageTable.id, fixture.messageID))
        .run()
        .pipe(Effect.orDie)
      const corrupted = yield* snapshot(db)
      expect((yield* SessionMessageProjection.checkActiveIntegrity(db)).violations).toContain(
        `Active assistant ${fixture.messageID} has an invalid message anchor`,
      )
      expect(Exit.isFailure(yield* SessionMessageProjection.drainActive(db).pipe(Effect.exit))).toBe(true)
      expect(yield* snapshot(db)).toEqual(corrupted)
      expect(corrupted).not.toEqual(before)
    }),
  )

  it.effect("rolls back invalid typed parts and detects a head Session mismatch", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* seedProject(db)
      const invalid = yield* seedActive(db, bus, "invalid-part", "running")
      yield* db.run(
        sql`UPDATE session_assistant_part SET data = ${JSON.stringify({ type: "text", text: 1 })} WHERE message_id = ${invalid.messageID} AND position = 0`,
      )
      const invalidSnapshot = yield* snapshot(db)
      expect(Exit.isFailure(yield* SessionMessageProjection.drainActive(db).pipe(Effect.exit))).toBe(true)
      expect(yield* snapshot(db)).toEqual(invalidSnapshot)

      yield* db.delete(SessionMessageTable).run().pipe(Effect.orDie)
      const owner = Session.ID.make("ses_drain_owner")
      const wrong = Session.ID.make("ses_drain_wrong")
      yield* insertSession(db, owner, "owner")
      yield* insertSession(db, wrong, "wrong")
      const messageID = SessionMessage.ID.make("msg_drain_mismatch")
      const assistant = SessionMessage.Assistant.make({
        id: messageID,
        type: "assistant",
        agent,
        model,
        time: { created: DateTime.makeUnsafe(1) },
        content: [],
      })
      const encoded = SessionMessageProjection.encode(assistant)
      yield* db.insert(SessionMessageTable).values({
        id: messageID,
        session_id: owner,
        type: "assistant",
        seq: 0,
        time_created: 1,
        data: encoded.head,
      })
      yield* db
        .insert(SessionAssistantActiveTable)
        .values({ message_id: messageID, session_id: wrong, data: encoded.head })
        .run()
        .pipe(Effect.orDie)
      expect((yield* SessionMessageProjection.checkActiveIntegrity(db)).violations).toContain(
        `head ${messageID} Session mismatch (${wrong} != ${owner})`,
      )
      expect(Exit.isFailure(yield* SessionMessageProjection.drainActive(db).pipe(Effect.exit))).toBe(true)
    }),
  )
})

function seedProject(db: Database.Interface["db"]) {
  return db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
}

function insertSession(db: Database.Interface["db"], id: Session.ID, label: string) {
  return db
    .insert(SessionTable)
    .values({ id, project_id: Project.ID.global, slug: label, directory: "/project", title: label, version: "test" })
    .run()
    .pipe(Effect.orDie)
}

function seedActive(db: Database.Interface["db"], bus: Bus.Interface, label: string, state: "running" | "streaming") {
  return Effect.gen(function* () {
    const sessionID = Session.ID.make(`ses_drain_${label}`)
    const messageID = SessionMessage.ID.make(`msg_drain_${label}`)
    yield* insertSession(db, sessionID, label)
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: messageID, agent, model })
    yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: messageID, ordinal: 0 })
    yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID: messageID, ordinal: 0, text: label })
    yield* bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID: messageID,
      id: label,
      name: "read",
    })
    if (state === "running") {
      yield* bus.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID: messageID,
        id: label,
        text: JSON.stringify({ path: label }),
      })
      yield* bus.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID: messageID,
        id: label,
        input: { path: label },
        executed: true,
      })
    }
    return { sessionID, messageID }
  })
}

function active(db: Database.Interface["db"], messageID: SessionMessage.ID) {
  return Effect.gen(function* () {
    const head = yield* db
      .select()
      .from(SessionAssistantActiveTable)
      .where(eq(SessionAssistantActiveTable.message_id, messageID))
      .get()
      .pipe(Effect.orDie)
    const parts = yield* db
      .select()
      .from(SessionAssistantPartTable)
      .where(eq(SessionAssistantPartTable.message_id, messageID))
      .orderBy(asc(SessionAssistantPartTable.position))
      .all()
      .pipe(Effect.orDie)
    return SessionMessageProjection.assemble(messageID, head!.data, parts)
  })
}

function auditUpdates(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db.run(sql`CREATE TEMP TABLE drain_update_audit (id TEXT NOT NULL)`)
    yield* db.run(sql`
      CREATE TEMP TRIGGER drain_update_anchor
      AFTER UPDATE OF data ON session_message
      BEGIN
        INSERT INTO drain_update_audit(id) VALUES (NEW.id);
      END
    `)
  })
}

function updateCounts(db: Database.Interface["db"]) {
  return db
    .all<{
      id: string
      writes: number
    }>(sql`SELECT id, count(*) AS writes FROM drain_update_audit GROUP BY id ORDER BY id`)
    .pipe(Effect.orDie)
}

function snapshot(db: Database.Interface["db"]) {
  return db
    .all<{ tableName: string; identity: string; data: string }>(
      sql`
      SELECT 'message' AS tableName, id AS identity, hex(CAST(data AS BLOB)) AS data FROM session_message
      UNION ALL
      SELECT 'head', message_id, hex(CAST(data AS BLOB)) FROM session_assistant_active
      UNION ALL
      SELECT 'part', message_id || ':' || position, hex(CAST(data AS BLOB)) FROM session_assistant_part
      ORDER BY tableName, identity
    `,
    )
    .pipe(Effect.orDie)
}
