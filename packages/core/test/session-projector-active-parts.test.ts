import { describe, expect } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Model } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageProjection } from "@opencode-ai/core/session/message-projection"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import {
  SessionAssistantActiveTable,
  SessionAssistantPartTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { Event } from "@opencode-ai/schema/event"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]), [[Bus.node, Bus.configured({ persist: true })]]),
)
const model = Model.Ref.make({ id: Model.ID.make("synthetic"), providerID: Provider.ID.make("synthetic") })
const retryModel = Model.Ref.make({
  id: Model.ID.make("synthetic-retry"),
  providerID: Provider.ID.make("synthetic"),
})
const build = Agent.ID.make("build")
const review = Agent.ID.make("review")
const seedDelta = 216 * 1024
const encodeAssistant = Schema.encodeSync(SessionMessage.Assistant)

type AuditRow = { table_name: string; operation: "insert" | "update"; writes: number; bytes: number }

describe("private active assistant projection", () => {
  it.effect("matches the W2 legacy oracle with bounded writes", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* insertProject(db)
      yield* createAudit(db)
      yield* attach(bus, db)

      const run = (label: "small" | "large", seedSize: number) =>
        Effect.gen(function* () {
          yield* db.run(sql`DELETE FROM temp.active_projection_audit`)
          const sessionID = Session.ID.make(`ses_active_w2_${label}`)
          const assistantMessageID = SessionMessage.ID.make(`msg_active_w2_${label}`)
          yield* insertSession(db, sessionID, label)
          const oracle = legacyOracle()
          const immutable = new Array<{ input: unknown; snapshot: unknown }>()
          let durableCount = 0
          let ephemeralCount = 0

          const publish = <D extends Event.DurableDefinition>(definition: D, data: Event.Data<D>) =>
            Effect.gen(function* () {
              const input = deepFreeze(data)
              const snapshot = structuredClone(input)
              const event = yield* bus.publish(definition, input)
              yield* oracle.apply(event as SessionEvent.DurableEvent)
              durableCount++
              immutable.push({ input, snapshot })
              expect(encodeAssistant((yield* activeAssistant(db, assistantMessageID))!)).toEqual(
                encodeAssistant(oracle.message()!),
              )
              return event
            })
          const publishEphemeral = <D extends Event.Definition>(definition: D, data: Event.Data<D>) =>
            Effect.gen(function* () {
              const input = deepFreeze(data)
              const snapshot = structuredClone(input)
              yield* bus.publish(definition, input)
              ephemeralCount++
              immutable.push({ input, snapshot })
            })

          yield* publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model })
          const seed = "seed:value:" + "s".repeat(seedSize)
          yield* publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
          yield* publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: seed })

          const ids = ["duplicate", "one", "duplicate", "three"]
          for (const [index, id] of ids.entries()) {
            const input = { command: `command-${index}`, seed: `input-${index}` }
            yield* publish(SessionEvent.Tool.Input.Started, {
              sessionID,
              assistantMessageID,
              id,
              name: index % 2 === 0 ? "read" : "bash",
            })
            yield* publishEphemeral(SessionEvent.Tool.Input.Delta, {
              sessionID,
              assistantMessageID,
              id,
              delta: `ephemeral-input-${index}`,
            })
            yield* publish(SessionEvent.Tool.Input.Ended, {
              sessionID,
              assistantMessageID,
              id,
              text: JSON.stringify(input),
            })
            yield* publish(SessionEvent.Tool.Called, {
              sessionID,
              assistantMessageID,
              id,
              input,
              executed: index % 2 === 0,
            })
            yield* publishEphemeral(SessionEvent.Tool.Progress, {
              sessionID,
              assistantMessageID,
              id,
              metadata: { forbidden: `ephemeral-progress-${index}` },
            })
            if (index % 2 === 0) {
              yield* publish(SessionEvent.Tool.Success, {
                sessionID,
                assistantMessageID,
                id,
                content: [{ type: "text", text: `success-${index}` }],
                metadata: { terminal: `success-${index}` },
                executed: true,
              })
              continue
            }
            yield* publish(SessionEvent.Tool.Failed, {
              sessionID,
              assistantMessageID,
              id,
              error: { type: "unknown", message: `failure-${index}` },
              content: [{ type: "text", text: `partial-${index}` }],
              metadata: { terminal: `failure-${index}` },
              executed: false,
            })
          }

          for (const index of [0, 1]) {
            yield* publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: index + 1 })
            yield* publishEphemeral(SessionEvent.Text.Delta, {
              sessionID,
              assistantMessageID,
              ordinal: index + 1,
              delta: `ephemeral-text-${index}`,
            })
            yield* publish(SessionEvent.Text.Ended, {
              sessionID,
              assistantMessageID,
              ordinal: index + 1,
              text: `final-text-${index}`,
            })
          }

          yield* publish(SessionEvent.Step.Streamed, { sessionID, assistantMessageID })
          yield* publish(SessionEvent.RetryScheduled, {
            sessionID,
            assistantMessageID,
            attempt: 1,
            at: 10,
            error: { type: "unknown", message: "retry" },
          })
          expect(oracle.message()?.retry?.attempt).toBe(1)
          yield* publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" })
          expect(oracle.message()?.retry).toBeUndefined()
          const partsBeforeRetry = yield* db
            .select()
            .from(SessionAssistantPartTable)
            .where(eq(SessionAssistantPartTable.message_id, assistantMessageID))
            .orderBy(asc(SessionAssistantPartTable.position))
            .all()
            .pipe(Effect.orDie)
          yield* publish(SessionEvent.Step.Started, {
            sessionID,
            assistantMessageID,
            agent: review,
            model: retryModel,
          })
          const partsAfterRetry = yield* db
            .select()
            .from(SessionAssistantPartTable)
            .where(eq(SessionAssistantPartTable.message_id, assistantMessageID))
            .orderBy(asc(SessionAssistantPartTable.position))
            .all()
            .pipe(Effect.orDie)

          const assistant = yield* activeAssistant(db, assistantMessageID)
          const rows = yield* audit(db)
          const anchorBytes = yield* dataBytes(db, "session_message", "id", assistantMessageID)
          const headBytes = yield* dataBytes(db, "session_assistant_active", "message_id", assistantMessageID)
          const partBytes = yield* db
            .get<{ bytes: number }>(
              sql`
              SELECT coalesce(sum(length(CAST(data AS BLOB))), 0) AS bytes
              FROM session_assistant_part WHERE message_id = ${assistantMessageID}
            `,
            )
            .pipe(Effect.orDie)
          const persisted = yield* persistedValues(db, sessionID, assistantMessageID)

          expect(durableCount).toBe(27)
          expect(ephemeralCount).toBe(10)
          expect(writeCount(rows, "session_message", "insert")).toBe(1)
          expect(writeCount(rows, "session_message", "update")).toBe(0)
          expect(writeCount(rows, "session_assistant_active", "insert")).toBe(1)
          expect(writeCount(rows, "session_assistant_active", "update")).toBe(4)
          expect(writeCount(rows, "session_assistant_part", "insert")).toBe(7)
          expect(writeCount(rows, "session_assistant_part", "update")).toBe(15)
          expect(partsAfterRetry).toEqual(partsBeforeRetry)
          expect(assistant?.content.map((part) => part.type)).toEqual([
            "text",
            "tool",
            "tool",
            "tool",
            "tool",
            "text",
            "text",
          ])
          expect(assistant?.content[1]).toMatchObject({
            type: "tool",
            id: "duplicate",
            state: { status: "completed", content: [{ text: "success-0" }] },
          })
          expect(assistant?.content[3]).toMatchObject({
            type: "tool",
            id: "duplicate",
            state: { status: "completed", content: [{ text: "success-2" }] },
          })
          expect(JSON.stringify(persisted)).not.toContain("ephemeral-")
          expect(yield* db.$count(EventTable, eq(EventTable.aggregate_id, sessionID))).toBe(27)
          expect(yield* Bus.latestSequence(db, sessionID)).toBe(26)
          for (const item of immutable) expect(item.input).toEqual(item.snapshot)

          return {
            rows,
            anchorBytes,
            headBytes,
            partBytes: partBytes?.bytes ?? 0,
            totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
          }
        })

      const small = yield* run("small", 4 * 1024)
      const large = yield* run("large", 220 * 1024)
      const cumulativeDelta = large.totalBytes - small.totalBytes
      const finalDelta = large.partBytes - small.partBytes
      const amplification = cumulativeDelta / finalDelta
      expect(large.anchorBytes).toBe(small.anchorBytes)
      expect(large.headBytes).toBe(small.headBytes)
      expect(finalDelta).toBe(seedDelta)
      expect(cumulativeDelta).toBe(seedDelta)
      expect(amplification).toBe(1)
      expect(amplification).toBeLessThan(2)
      console.info("S4 M2 W2 structural evidence", { small, large, finalDelta, cumulativeDelta, amplification })
    }),
  )

  it.effect("matches W3 reasoning ordinals and latest-text selection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* insertProject(db)
      yield* createAudit(db)
      const sessionID = Session.ID.make("ses_active_w3")
      const assistantMessageID = SessionMessage.ID.make("msg_active_w3")
      yield* insertSession(db, sessionID, "w3")
      yield* attach(bus, db)
      const oracle = legacyOracle()
      let durableCount = 0
      const publish = <D extends Event.DurableDefinition>(definition: D, data: Event.Data<D>) =>
        Effect.gen(function* () {
          const input = deepFreeze(data)
          const snapshot = structuredClone(input)
          const event = yield* bus.publish(definition, input)
          yield* oracle.apply(event as SessionEvent.DurableEvent)
          durableCount++
          expect(input).toEqual(snapshot)
          expect(encodeAssistant((yield* activeAssistant(db, assistantMessageID))!)).toEqual(
            encodeAssistant(oracle.message()!),
          )
        })

      yield* publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model })
      yield* publish(SessionEvent.Reasoning.Started, { sessionID, assistantMessageID, ordinal: 0, state: { start: 0 } })
      yield* publish(SessionEvent.Reasoning.Started, { sessionID, assistantMessageID, ordinal: 1, state: { start: 1 } })
      yield* publish(SessionEvent.Reasoning.Ended, {
        sessionID,
        assistantMessageID,
        ordinal: 1,
        text: "reasoning-one",
        state: { end: 1 },
      })
      yield* publish(SessionEvent.Reasoning.Ended, {
        sessionID,
        assistantMessageID,
        ordinal: 0,
        text: "reasoning-zero",
        state: { end: 0 },
      })
      yield* publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
      yield* publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 1 })
      yield* publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: "latest-text" })

      const assistant = yield* activeAssistant(db, assistantMessageID)
      const rows = yield* audit(db)
      expect(durableCount).toBe(8)
      expect(writeCount(rows, "session_message", "insert")).toBe(1)
      expect(writeCount(rows, "session_message", "update")).toBe(0)
      expect(writeCount(rows, "session_assistant_active", "insert")).toBe(1)
      expect(writeCount(rows, "session_assistant_active", "update")).toBe(0)
      expect(writeCount(rows, "session_assistant_part", "insert")).toBe(4)
      expect(writeCount(rows, "session_assistant_part", "update")).toBe(3)
      expect(assistant?.content).toMatchObject([
        { type: "reasoning", text: "reasoning-zero", state: { end: 0 } },
        { type: "reasoning", text: "reasoning-one", state: { end: 1 } },
        { type: "text", text: "" },
        { type: "text", text: "latest-text" },
      ])
      console.info("S4 M2 W3 structural evidence", { rows })
    }),
  )

  it.effect("rolls back projection, sequence, and event state on transaction failure", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* insertProject(db)
      const sessionID = Session.ID.make("ses_active_rollback")
      const assistantMessageID = SessionMessage.ID.make("msg_active_rollback")
      yield* insertSession(db, sessionID, "rollback")
      yield* attach(bus, db)
      yield* bus.project(SessionEvent.Step.Started, () => Effect.die(new Error("injected projection failure")))
      const input = deepFreeze({ sessionID, assistantMessageID, agent: build, model })
      const snapshot = structuredClone(input)
      const exit = yield* bus.publish(SessionEvent.Step.Started, input).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(input).toEqual(snapshot)
      expect(yield* db.$count(SessionMessageTable, eq(SessionMessageTable.id, assistantMessageID))).toBe(0)
      expect(
        yield* db.$count(SessionAssistantActiveTable, eq(SessionAssistantActiveTable.message_id, assistantMessageID)),
      ).toBe(0)
      expect(
        yield* db.$count(SessionAssistantPartTable, eq(SessionAssistantPartTable.message_id, assistantMessageID)),
      ).toBe(0)
      expect(yield* db.$count(EventSequenceTable, eq(EventSequenceTable.aggregate_id, sessionID))).toBe(0)
      expect(yield* db.$count(EventTable, eq(EventTable.aggregate_id, sessionID))).toBe(0)
    }),
  )
})

function attach(bus: Bus.Interface, db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* bus.project(SessionEvent.Step.Started, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Step.Streamed, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Text.Started, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Text.Ended, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Reasoning.Started, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Reasoning.Ended, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Tool.Input.Started, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Tool.Input.Ended, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Tool.Called, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Tool.Success, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Tool.Failed, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.RetryScheduled, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Execution.Succeeded, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Execution.Failed, (event) => SessionMessageProjection.project(db, event))
    yield* bus.project(SessionEvent.Execution.Interrupted, (event) => SessionMessageProjection.project(db, event))
  })
}

function legacyOracle() {
  let assistant: SessionMessage.Assistant | undefined
  const adapter: SessionMessageUpdater.Adapter = {
    getAgent: () => Effect.succeed(undefined),
    getModel: () => Effect.succeed(undefined),
    getLocation: () => Effect.succeed(undefined),
    getCurrentAssistant: () => Effect.succeed(assistant?.time.completed ? undefined : assistant),
    getAssistant: (messageID) => Effect.succeed(assistant?.id === messageID ? assistant : undefined),
    getShell: () => Effect.succeed(undefined),
    getCompaction: () => Effect.succeed(undefined),
    updateAssistant: (value) => Effect.sync(() => void (assistant = value)),
    updateShell: () => Effect.die(new Error("Unexpected shell oracle update")),
    updateCompaction: () => Effect.die(new Error("Unexpected compaction oracle update")),
    appendMessage: (message) => {
      if (message.type !== "assistant") return Effect.die(new Error(`Unexpected ${message.type} oracle append`))
      return Effect.sync(() => void (assistant = message))
    },
  }
  return {
    apply: (event: SessionEvent.DurableEvent) => SessionMessageUpdater.update(adapter, event),
    message: () => assistant,
  }
}

function activeAssistant(db: Database.Interface["db"], messageID: SessionMessage.ID) {
  return Effect.gen(function* () {
    const head = yield* db
      .select()
      .from(SessionAssistantActiveTable)
      .where(eq(SessionAssistantActiveTable.message_id, messageID))
      .get()
      .pipe(Effect.orDie)
    if (!head) return
    const parts = yield* db
      .select()
      .from(SessionAssistantPartTable)
      .where(eq(SessionAssistantPartTable.message_id, messageID))
      .orderBy(asc(SessionAssistantPartTable.position))
      .all()
      .pipe(Effect.orDie)
    return SessionMessageProjection.assemble(messageID, head.data, parts)
  })
}

function insertProject(db: Database.Interface["db"]) {
  return db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
}

function insertSession(db: Database.Interface["db"], sessionID: Session.ID, label: string) {
  return db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: label,
      directory: "/project",
      title: label,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
}

function createAudit(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      CREATE TEMP TABLE active_projection_audit (
        table_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        bytes INTEGER NOT NULL
      )
    `)
    for (const table of ["session_message", "session_assistant_active", "session_assistant_part"] as const) {
      yield* db.run(
        sql.raw(`
        CREATE TEMP TRIGGER active_projection_${table}_insert
        AFTER INSERT ON ${table}
        BEGIN
          INSERT INTO active_projection_audit(table_name, operation, bytes)
          VALUES ('${table}', 'insert', length(CAST(NEW.data AS BLOB)));
        END
      `),
      )
      yield* db.run(
        sql.raw(`
        CREATE TEMP TRIGGER active_projection_${table}_update
        AFTER UPDATE OF data ON ${table}
        BEGIN
          INSERT INTO active_projection_audit(table_name, operation, bytes)
          VALUES ('${table}', 'update', length(CAST(NEW.data AS BLOB)));
        END
      `),
      )
    }
  })
}

function audit(db: Database.Interface["db"]) {
  return db
    .all<AuditRow>(
      sql`
      SELECT table_name, operation, count(*) AS writes, coalesce(sum(bytes), 0) AS bytes
      FROM temp.active_projection_audit
      GROUP BY table_name, operation
      ORDER BY table_name, operation
    `,
    )
    .pipe(Effect.orDie)
}

function writeCount(rows: readonly AuditRow[], table: string, operation: AuditRow["operation"]) {
  return rows.find((row) => row.table_name === table && row.operation === operation)?.writes ?? 0
}

function dataBytes(db: Database.Interface["db"], table: string, key: string, value: string) {
  return db
    .get<{
      bytes: number
    }>(sql.raw(`SELECT length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE ${key} = '${value}'`))
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.bytes ?? 0),
    )
}

function persistedValues(db: Database.Interface["db"], sessionID: Session.ID, messageID: SessionMessage.ID) {
  return Effect.all([
    db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).all().pipe(Effect.orDie),
    db
      .select()
      .from(SessionAssistantActiveTable)
      .where(eq(SessionAssistantActiveTable.message_id, messageID))
      .all()
      .pipe(Effect.orDie),
    db
      .select()
      .from(SessionAssistantPartTable)
      .where(eq(SessionAssistantPartTable.message_id, messageID))
      .all()
      .pipe(Effect.orDie),
    db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie),
  ])
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
