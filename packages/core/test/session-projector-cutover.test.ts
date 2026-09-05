import { describe, expect } from "bun:test"
import { asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Exit, Schema } from "effect"
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
import { SessionProjector } from "@opencode-ai/core/session/projector"
import {
  SessionAssistantActiveTable,
  SessionAssistantPartTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { Event } from "@opencode-ai/schema/event"
import { Money } from "@opencode-ai/schema/money"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
    [Bus.node, Bus.configured({ persist: true })],
  ]),
)
const model = Model.Ref.make({ id: Model.ID.make("synthetic"), providerID: Provider.ID.make("synthetic") })
const build = Agent.ID.make("build")
const review = Agent.ID.make("review")
const encodeAssistant = Schema.encodeSync(SessionMessage.Assistant)

type AuditRow = {
  table_name: string
  operation: "insert" | "update" | "delete"
  message_id: string
  bytes: number
}

describe("SessionProjector active assistant cutover", () => {
  it.effect("bounds preterminal writes and folds terminal state exactly once", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* setup(db)
      yield* createAudit(db)
      const sessionID = Session.ID.make("ses_cutover_terminal")
      const assistantMessageID = SessionMessage.ID.make("msg_cutover_terminal")
      yield* insertSession(db, sessionID)

      const publish = <D extends Event.DurableDefinition>(definition: D, data: Event.Data<D>) =>
        Effect.gen(function* () {
          yield* clearAudit(db)
          const event = yield* bus.publish(definition, data)
          const rows = yield* audit(db)
          if (definition.type !== SessionEvent.Step.Ended.type) {
            expect(count(rows, "session_message", "update")).toBe(0)
            expect(count(rows, "session_assistant_active", "update")).toBeLessThanOrEqual(1)
            expect(
              count(rows, "session_assistant_part", "insert") + count(rows, "session_assistant_part", "update"),
            ).toBeLessThanOrEqual(1)
          }
          return event
        })

      yield* publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model })
      yield* publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
      yield* publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID,
        ordinal: 0,
        text: "terminal text",
      })
      yield* publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        id: "duplicate",
        name: "read",
      })
      yield* publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID,
        id: "duplicate",
        text: '{"path":"one"}',
      })
      yield* publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        id: "duplicate",
        input: { path: "one" },
        executed: true,
      })
      yield* publish(SessionEvent.Tool.Success, {
        sessionID,
        assistantMessageID,
        id: "duplicate",
        content: [{ type: "text", text: "result" }],
        metadata: { source: "fixture" },
        executed: true,
      })

      const anchor = yield* messageRow(db, assistantMessageID)
      const active = yield* SessionMessageProjection.hydrate(db, [anchor])
      expect(active[0]).toMatchObject({
        id: assistantMessageID,
        content: [
          { type: "text", text: "terminal text" },
          { type: "tool", id: "duplicate", state: { status: "completed" } },
        ],
      })

      yield* clearAudit(db)
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        finish: "stop",
        cost: Money.USD.make(1.25),
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      })
      const terminalRows = yield* audit(db)
      expect(count(terminalRows, "session_message", "update")).toBe(1)
      expect(count(terminalRows, "session_assistant_active", "delete")).toBe(1)
      expect(yield* db.$count(SessionAssistantActiveTable, eq(SessionAssistantActiveTable.session_id, sessionID))).toBe(
        0,
      )
      expect(
        yield* db.$count(SessionAssistantPartTable, eq(SessionAssistantPartTable.message_id, assistantMessageID)),
      ).toBe(0)
      expect(decodeAssistant(yield* messageRow(db, assistantMessageID))).toMatchObject({
        finish: "stop",
        cost: 1.25,
        tokens: { input: 10, output: 4 },
      })
      expect(yield* sessionRow(db, sessionID)).toMatchObject({ cost: 1.25, tokens_input: 10, tokens_output: 4 })
    }),
  )

  it.effect("hydrates concurrent active assistants across Sessions in one ordered window", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* setup(db)
      const firstSession = Session.ID.make("ses_hydrate_multi_first")
      const secondSession = Session.ID.make("ses_hydrate_multi_second")
      const firstMessage = SessionMessage.ID.make("msg_hydrate_multi_first")
      const secondMessage = SessionMessage.ID.make("msg_hydrate_multi_second")
      yield* insertSession(db, firstSession)
      yield* insertSession(db, secondSession)

      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: firstSession,
        assistantMessageID: firstMessage,
        agent: build,
        model,
      })
      yield* bus.publish(SessionEvent.Text.Started, {
        sessionID: firstSession,
        assistantMessageID: firstMessage,
        ordinal: 0,
      })
      yield* bus.publish(SessionEvent.Text.Ended, {
        sessionID: firstSession,
        assistantMessageID: firstMessage,
        ordinal: 0,
        text: "first active content",
      })
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: secondSession,
        assistantMessageID: secondMessage,
        agent: review,
        model,
      })
      yield* bus.publish(SessionEvent.Text.Started, {
        sessionID: secondSession,
        assistantMessageID: secondMessage,
        ordinal: 0,
      })
      yield* bus.publish(SessionEvent.Text.Ended, {
        sessionID: secondSession,
        assistantMessageID: secondMessage,
        ordinal: 0,
        text: "second active content",
      })

      const hydrated = yield* SessionMessageProjection.hydrate(db, [
        yield* messageRow(db, secondMessage),
        yield* messageRow(db, firstMessage),
      ])
      expect(hydrated.map((message) => message.id)).toEqual([secondMessage, firstMessage])
      expect(hydrated).toMatchObject([
        { agent: review, content: [{ type: "text", text: "second active content" }] },
        { agent: build, content: [{ type: "text", text: "first active content" }] },
      ])

      expect(yield* SessionMessageProjection.hydrate(db, [])).toEqual([])
      yield* end(bus, firstSession, firstMessage)
      expect(yield* SessionMessageProjection.hydrate(db, [yield* messageRow(db, firstMessage)])).toMatchObject([
        { id: firstMessage, finish: "stop", content: [{ type: "text", text: "first active content" }] },
      ])

      const conflictingMessage = SessionMessage.ID.make("msg_hydrate_multi_conflict")
      const conflicting = SessionMessage.Assistant.make({
        id: conflictingMessage,
        type: "assistant",
        agent: build,
        model,
        time: { created: DateTime.makeUnsafe(2) },
        content: [],
      })
      yield* insertAssistant(db, secondSession, 100, conflicting)
      const duplicateExit = yield* db
        .insert(SessionAssistantActiveTable)
        .values({
          message_id: conflictingMessage,
          session_id: secondSession,
          data: SessionMessageProjection.encode(conflicting).head,
        })
        .run()
        .pipe(Effect.exit)
      expect(Exit.isFailure(duplicateExit)).toBe(true)
      expect(yield* activeIDs(db, secondSession)).toEqual([secondMessage])
    }),
  )

  it.effect("preserves same-ID parts and atomically supersedes sidecar and legacy assistants", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* setup(db)
      yield* createAudit(db)
      const sessionID = Session.ID.make("ses_cutover_supersession")
      const first = SessionMessage.ID.make("msg_cutover_first")
      const second = SessionMessage.ID.make("msg_cutover_second")
      const third = SessionMessage.ID.make("msg_cutover_third")
      yield* insertSession(db, sessionID)
      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: first, agent: build, model })
      yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: first, ordinal: 0 })
      yield* bus.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID: first,
        ordinal: 0,
        text: "preserved",
      })
      const beforeRetry = yield* partRows(db, first)

      yield* clearAudit(db)
      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: first, agent: review, model })
      expect(yield* partRows(db, first)).toEqual(beforeRetry)
      expect(count(yield* audit(db), "session_message", "update")).toBe(0)

      yield* clearAudit(db)
      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: second, agent: build, model })
      const supersession = yield* audit(db)
      expect(count(supersession, "session_message", "update")).toBe(1)
      expect(decodeAssistant(yield* messageRow(db, first))).toMatchObject({
        content: [{ type: "text", text: "preserved" }],
        time: { completed: expect.anything() },
      })
      expect(yield* activeIDs(db, sessionID)).toEqual([second])

      const old = SessionMessage.Assistant.make({
        id: third,
        type: "assistant",
        agent: build,
        model,
        time: { created: DateTime.makeUnsafe(1) },
        content: [{ type: "text", text: "legacy" }],
      })
      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, second)).run().pipe(Effect.orDie)
      yield* insertAssistant(db, sessionID, 50, old)
      const fourth = SessionMessage.ID.make("msg_cutover_fourth")
      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: fourth, agent: build, model })
      expect(decodeAssistant(yield* messageRow(db, third))).toMatchObject({ time: { completed: expect.anything() } })
      expect(yield* activeIDs(db, sessionID)).toEqual([fourth])
    }),
  )

  it.effect("reopens a settled assistant atomically and restores it on abort", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* setup(db)
      const sessionID = Session.ID.make("ses_cutover_reopen")
      const assistantMessageID = SessionMessage.ID.make("msg_cutover_reopen")
      yield* insertSession(db, sessionID)
      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model })
      yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
      yield* bus.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID,
        ordinal: 0,
        text: "reopened content",
      })
      yield* end(bus, sessionID, assistantMessageID)

      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: review, model })
      const [reopened] = yield* SessionMessageProjection.hydrate(db, [yield* messageRow(db, assistantMessageID)])
      expect(reopened).toMatchObject({
        agent: review,
        content: [{ type: "text", text: "reopened content" }],
      })
      expect(reopened?.type === "assistant" ? reopened.time.completed : null).toBeUndefined()
      yield* end(bus, sessionID, assistantMessageID)
      const settled = yield* messageRow(db, assistantMessageID)

      const exit = yield* bus
        .publish(
          SessionEvent.Step.Started,
          { sessionID, assistantMessageID, agent: build, model },
          { commit: () => Effect.die("abort reopen") },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* messageRow(db, assistantMessageID)).toEqual(settled)
      expect(yield* activeIDs(db, sessionID)).toEqual([])
      expect(yield* partRows(db, assistantMessageID)).toEqual([])
    }),
  )

  it.effect("folds failed steps and rejects active content updates or dual owners", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* setup(db)
      yield* createAudit(db)
      const sessionID = Session.ID.make("ses_cutover_failed")
      const assistantMessageID = SessionMessage.ID.make("msg_cutover_failed")
      yield* insertSession(db, sessionID)
      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model })
      yield* clearAudit(db)
      yield* bus.publish(SessionEvent.Step.Failed, {
        sessionID,
        assistantMessageID,
        error: { type: "provider.internal", message: "failed" },
        cost: Money.USD.make(0.5),
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      expect(count(yield* audit(db), "session_message", "update")).toBe(1)
      expect(decodeAssistant(yield* messageRow(db, assistantMessageID))).toMatchObject({
        finish: "error",
        error: { type: "provider.internal", message: "failed" },
      })

      const activeID = SessionMessage.ID.make("msg_cutover_guarded")
      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: activeID, agent: build, model })
      const beforeContent = yield* allState(db, sessionID)
      const contentExit = yield* bus
        .publish(SessionEvent.MessageContentUpdated, {
          sessionID,
          messageID: activeID,
          content: [{ type: "text", text: "forbidden" }],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(contentExit)).toBe(true)
      expect(yield* allState(db, sessionID)).toEqual(beforeContent)

      const legacyID = SessionMessage.ID.make("msg_cutover_dual_legacy")
      yield* insertAssistant(
        db,
        sessionID,
        100,
        SessionMessage.Assistant.make({
          id: legacyID,
          type: "assistant",
          agent: build,
          model,
          time: { created: DateTime.makeUnsafe(1) },
          content: [],
        }),
      )
      const beforeDual = yield* allState(db, sessionID)
      const dualExit = yield* bus
        .publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: activeID, ordinal: 0 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(dualExit)).toBe(true)
      expect(yield* allState(db, sessionID)).toEqual(beforeDual)
    }),
  )

  it.effect("makes committed replay write-free, rebuilds identically, and rejects divergence unchanged", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* setup(db)
      yield* createAudit(db)
      const sessionID = Session.ID.make("ses_cutover_replay")
      const assistantMessageID = SessionMessage.ID.make("msg_cutover_replay")
      yield* insertSession(db, sessionID)
      const serialized = new Array<Bus.SerializedEvent>()
      const publish = <D extends Event.DurableDefinition>(definition: D, data: Event.Data<D>) =>
        bus.publish(definition, data).pipe(
          Effect.tap((event) =>
            Effect.sync(() =>
              serialized.push({
                id: event.id,
                type: Bus.versionedType(event.type, event.durable.version),
                created: event.created,
                seq: event.durable.seq,
                aggregateID: event.durable.aggregateID,
                data: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(event.data),
              }),
            ),
          ),
        )
      yield* publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model })
      yield* publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
      yield* publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID,
        ordinal: 0,
        text: "replay",
      })
      yield* publish(SessionEvent.Step.Ended, terminal(sessionID, assistantMessageID))
      const expected = yield* messageRow(db, assistantMessageID)
      const expectedUsage = yield* sessionRow(db, sessionID)

      yield* clearAudit(db)
      yield* bus.replay(serialized.at(-1)!)
      expect(yield* audit(db)).toEqual([])

      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* bus.remove(sessionID)
      yield* clearAudit(db)
      yield* Effect.forEach(serialized, (event) => bus.replay(event), { discard: true })
      expect(decodeAssistant(yield* messageRow(db, assistantMessageID))).toEqual(decodeAssistant(expected))
      expect(yield* sessionRow(db, sessionID)).toMatchObject({
        cost: expectedUsage.cost,
        tokens_input: expectedUsage.tokens_input,
        tokens_output: expectedUsage.tokens_output,
      })
      expect(count(yield* audit(db), "session_message", "update")).toBe(1)

      const before = yield* allState(db, sessionID)
      const last = serialized.at(-1)!
      const exit = yield* bus.replay({ ...last, data: { ...last.data, finish: "length" } }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* allState(db, sessionID)).toEqual(before)
    }),
  )

  it.effect("rolls back part, fold/usage, and commit-hook failures", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* setup(db)

      const partSession = Session.ID.make("ses_cutover_fail_part")
      const partMessage = SessionMessage.ID.make("msg_cutover_fail_part")
      yield* insertSession(db, partSession)
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: partSession,
        assistantMessageID: partMessage,
        agent: build,
        model,
      })
      yield* bus.publish(SessionEvent.Text.Started, {
        sessionID: partSession,
        assistantMessageID: partMessage,
        ordinal: 0,
      })
      const beforePart = yield* allState(db, partSession)
      yield* bus.project(SessionEvent.Text.Ended, () => Effect.die("after part mutation"))
      const partExit = yield* bus
        .publish(SessionEvent.Text.Ended, {
          sessionID: partSession,
          assistantMessageID: partMessage,
          ordinal: 0,
          text: "must roll back",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(partExit)).toBe(true)
      expect(yield* allState(db, partSession)).toEqual(beforePart)

      const terminalSession = Session.ID.make("ses_cutover_fail_terminal")
      const terminalMessage = SessionMessage.ID.make("msg_cutover_fail_terminal")
      yield* insertSession(db, terminalSession)
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: terminalSession,
        assistantMessageID: terminalMessage,
        agent: build,
        model,
      })
      yield* bus.publish(SessionEvent.Text.Started, {
        sessionID: terminalSession,
        assistantMessageID: terminalMessage,
        ordinal: 0,
      })
      const beforeTerminal = yield* allState(db, terminalSession)
      yield* bus.project(SessionEvent.Step.Ended, () => Effect.die("after fold and usage"))
      const terminalExit = yield* end(bus, terminalSession, terminalMessage).pipe(Effect.exit)
      expect(Exit.isFailure(terminalExit)).toBe(true)
      expect(yield* allState(db, terminalSession)).toEqual(beforeTerminal)

      const commitSession = Session.ID.make("ses_cutover_fail_commit")
      const commitMessage = SessionMessage.ID.make("msg_cutover_fail_commit")
      yield* insertSession(db, commitSession)
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: commitSession,
        assistantMessageID: commitMessage,
        agent: build,
        model,
      })
      const beforeCommit = yield* allState(db, commitSession)
      const commitExit = yield* bus
        .publish(SessionEvent.Step.Ended, terminal(commitSession, commitMessage), {
          commit: () => Effect.die("commit hook failed"),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(commitExit)).toBe(true)
      expect(yield* allState(db, commitSession)).toEqual(beforeCommit)
    }),
  )
})

function terminal(sessionID: Session.ID, assistantMessageID: SessionMessage.ID) {
  return {
    sessionID,
    assistantMessageID,
    finish: "stop" as const,
    cost: Money.USD.make(2),
    tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function end(bus: Bus.Interface, sessionID: Session.ID, assistantMessageID: SessionMessage.ID) {
  return bus.publish(SessionEvent.Step.Ended, terminal(sessionID, assistantMessageID))
}

function setup(db: Database.Interface["db"]) {
  return db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
}

function insertSession(db: Database.Interface["db"], sessionID: Session.ID) {
  return db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: "/project",
      title: sessionID,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
}

function insertAssistant(
  db: Database.Interface["db"],
  sessionID: Session.ID,
  seq: number,
  assistant: SessionMessage.Assistant,
) {
  const encoded = encodeAssistant(assistant)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({ id: SessionMessage.ID.make(id), session_id: sessionID, seq, type, time_created: 1, data })
    .run()
    .pipe(Effect.orDie)
}

function decodeAssistant(row: typeof SessionMessageTable.$inferSelect) {
  return Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
}

function messageRow(db: Database.Interface["db"], messageID: SessionMessage.ID) {
  return db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, messageID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.die(new Error(`Missing message ${messageID}`)))),
    )
}

function sessionRow(db: Database.Interface["db"], sessionID: Session.ID) {
  return db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.die(new Error(`Missing session ${sessionID}`)))),
    )
}

function activeIDs(db: Database.Interface["db"], sessionID: Session.ID) {
  return db
    .select({ id: SessionAssistantActiveTable.message_id })
    .from(SessionAssistantActiveTable)
    .where(eq(SessionAssistantActiveTable.session_id, sessionID))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.id)),
    )
}

function partRows(db: Database.Interface["db"], messageID: SessionMessage.ID) {
  return db
    .select()
    .from(SessionAssistantPartTable)
    .where(eq(SessionAssistantPartTable.message_id, messageID))
    .orderBy(asc(SessionAssistantPartTable.position))
    .all()
    .pipe(Effect.orDie)
}

function allState(db: Database.Interface["db"], sessionID: Session.ID) {
  return Effect.all([
    db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).all().pipe(Effect.orDie),
    db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).all().pipe(Effect.orDie),
    db
      .select()
      .from(SessionAssistantActiveTable)
      .where(eq(SessionAssistantActiveTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie),
    db
      .select()
      .from(SessionAssistantPartTable)
      .where(
        sql`${SessionAssistantPartTable.message_id} IN (SELECT message_id FROM session_message WHERE session_id = ${sessionID})`,
      )
      .all()
      .pipe(Effect.orDie),
    db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).all().pipe(Effect.orDie),
    db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie),
  ])
}

function createAudit(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      CREATE TEMP TABLE cutover_audit (
        table_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        message_id TEXT NOT NULL,
        bytes INTEGER NOT NULL
      )
    `)
    for (const table of ["session_message", "session_assistant_active", "session_assistant_part"] as const) {
      const identity = table === "session_message" ? "id" : "message_id"
      for (const operation of ["insert", "update", "delete"] as const) {
        const value = operation === "delete" ? "OLD" : "NEW"
        yield* db.run(
          sql.raw(`
            CREATE TEMP TRIGGER cutover_${table}_${operation}
            AFTER ${operation.toUpperCase()} ON ${table}
            BEGIN
              INSERT INTO cutover_audit(table_name, operation, message_id, bytes)
              VALUES ('${table}', '${operation}', ${value}.${identity}, length(CAST(${value}.data AS BLOB)));
            END
          `),
        )
      }
    }
  })
}

function clearAudit(db: Database.Interface["db"]) {
  return db.run(sql`DELETE FROM temp.cutover_audit`).pipe(Effect.orDie)
}

function audit(db: Database.Interface["db"]) {
  return db.all<AuditRow>(sql`SELECT * FROM temp.cutover_audit ORDER BY rowid`).pipe(Effect.orDie)
}

function count(rows: readonly AuditRow[], table: string, operation: AuditRow["operation"]) {
  return rows.filter((row) => row.table_name === table && row.operation === operation).length
}
