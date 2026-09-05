import { describe, expect } from "bun:test"
import { and, asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer, LayerMap, Schema, Stream } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { Model } from "@opencode-ai/core/model"
import { PluginHooks } from "@opencode-ai/core/plugin/hooks"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor-service"
import { Project } from "@opencode-ai/core/project"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionContinuation } from "@opencode-ai/core/session/continuation"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionInbox } from "@opencode-ai/core/session/inbox"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRevert } from "@opencode-ai/core/session/revert"
import {
  SessionAssistantActiveTable,
  SessionAssistantPartTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTransfer } from "@opencode-ai/core/session/transfer"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Event } from "@opencode-ai/schema/event"
import { Money } from "@opencode-ai/schema/money"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { globalProjectLayer } from "./lib/project"
import { testEffect } from "./lib/effect"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = Model.Ref.make({ id: Model.ID.make("lifecycle-model"), providerID: Provider.ID.make("test") })
const build = Agent.ID.make("build")
const tokens = { input: 7, output: 3, reasoning: 1, cache: { read: 2, write: 1 } }
const locationLayer = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      Layer.mergeAll(
        LayerNode.compile(PluginHooks.node),
        Layer.mock(Snapshot.Service, {
          capture: () => Effect.undefined,
          restore: () => Effect.void,
        }),
        Layer.succeed(PluginSupervisor.Service, { awaitActivation: Effect.void }),
      ) as Layer.Layer<LocationServices>,
  ),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionContinuation.node,
      Session.node,
      SessionTransfer.node,
    ]),
    [
      [Bus.node, Bus.configured({ persist: true })],
      [Project.node, globalProjectLayer],
      [LocationServiceMap.node, locationLayer],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

describe("active assistant lifecycle compatibility", () => {
  it.effect("forks settled boundaries but excludes active, reopened, and legacy-active assistants", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ location, title: "Lifecycle parent" })
      const user = yield* sessions.prompt({ sessionID: parent.id, text: "Keep this prefix", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")
      const assistantMessageID = SessionMessage.ID.make("msg_lifecycle_fork_active")
      yield* activeText(bus, parent.id, assistantMessageID, "active answer")

      const before = yield* sessions.fork({
        sessionID: parent.id,
        boundary: { type: "before", messageID: assistantMessageID },
      })
      const through = yield* sessions.fork({ sessionID: parent.id, boundary: { type: "through" } })
      expect(yield* sessions.context(parent.id)).toMatchObject([
        { id: user.id, type: "user" },
        { id: assistantMessageID, type: "assistant", content: [{ type: "text", text: "active answer" }] },
      ])
      expect(yield* sessions.context(before.id)).toMatchObject([{ type: "user", text: "Keep this prefix" }])
      expect(yield* sessions.context(through.id)).toMatchObject([{ type: "user", text: "Keep this prefix" }])
      yield* assertNoSidecar(db, before.id)
      yield* assertNoSidecar(db, through.id)
      expect(yield* activeCount(db, parent.id)).toBe(1)
      expect(yield* partCount(db, assistantMessageID)).toBe(1)

      yield* end(bus, parent.id, assistantMessageID)
      const folded = yield* sessions.fork({ sessionID: parent.id, boundary: { type: "through" } })
      expect(yield* sessions.context(folded.id)).toMatchObject([
        { type: "user", text: "Keep this prefix" },
        { type: "assistant", content: [{ type: "text", text: "active answer" }], finish: "stop" },
      ])
      yield* assertNoSidecar(db, folded.id)

      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: parent.id,
        assistantMessageID,
        agent: build,
        model,
      })
      const reopened = yield* sessions.fork({ sessionID: parent.id, boundary: { type: "through" } })
      expect(yield* sessions.context(reopened.id)).toMatchObject([{ type: "user", text: "Keep this prefix" }])
      yield* assertNoSidecar(db, reopened.id)

      yield* end(bus, parent.id, assistantMessageID)
      const legacyID = SessionMessage.ID.make("msg_lifecycle_legacy_active")
      yield* insertMessage(
        db,
        parent.id,
        100,
        SessionMessage.Assistant.make({
          id: legacyID,
          type: "assistant",
          agent: build,
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", text: "legacy active" })],
          time: { created: DateTime.makeUnsafe(100) },
        }),
      )
      const legacy = yield* sessions.message({ sessionID: parent.id, messageID: legacyID })
      expect(legacy).toMatchObject({
        content: [{ type: "text", text: "legacy active" }],
      })
      expect(legacy?.type === "assistant" ? legacy.time.completed : null).toBeUndefined()
      const legacyFork = yield* sessions.fork({ sessionID: parent.id, boundary: { type: "through" } })
      expect((yield* sessions.context(legacyFork.id)).some((message) => message.id === legacyID)).toBe(false)
      expect((yield* (yield* SessionTransfer.Service).export({ sessionID: parent.id })).messages).not.toContainEqual(
        expect.objectContaining({ id: legacyID }),
      )
    }),
  )

  it.effect("plans through an active snapshot and cascades revert/remove without partial failure", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const reverted = yield* sessions.create({ location })
      const boundary = yield* sessions.prompt({ sessionID: reverted.id, text: "revert boundary", resume: false })
      yield* SessionInbox.promote(db, bus, reverted.id, "steer")
      const activeID = SessionMessage.ID.make("msg_lifecycle_revert_active")
      yield* activeText(bus, reverted.id, activeID, "active revert tail", Snapshot.ID.make("tree-active"))
      expect(yield* sessions.message({ sessionID: reverted.id, messageID: activeID })).toMatchObject({
        snapshot: { start: "tree-active" },
      })
      expect(
        yield* sessions.revert.stage({ sessionID: reverted.id, messageID: boundary.id, files: false }),
      ).toMatchObject({
        messageID: boundary.id,
      })
      yield* sessions.revert.commit(reverted.id)
      expect(yield* activeCount(db, reverted.id)).toBe(0)
      expect(yield* partCount(db, activeID)).toBe(0)
      expect(yield* messageCount(db, reverted.id)).toBe(0)

      const failed = yield* sessions.create({ location })
      const failedBoundary = yield* sessions.prompt({ sessionID: failed.id, text: "preserve boundary", resume: false })
      yield* SessionInbox.promote(db, bus, failed.id, "steer")
      const failedActiveID = SessionMessage.ID.make("msg_lifecycle_revert_failure")
      yield* activeText(bus, failed.id, failedActiveID, "preserve active tail")
      yield* sessions.revert.stage({ sessionID: failed.id, messageID: failedBoundary.id, files: false })
      const before = yield* sidecarState(db, failed.id, failedActiveID)
      yield* bus.project(SessionEvent.RevertEvent.Committed, () => Effect.die("injected revert failure"))
      expect(Exit.isFailure(yield* sessions.revert.commit(failed.id).pipe(Effect.exit))).toBe(true)
      expect(yield* sidecarState(db, failed.id, failedActiveID)).toEqual(before)
      expect(yield* sessions.context(failed.id)).toMatchObject([
        { type: "user", text: "preserve boundary" },
        { type: "assistant", content: [{ type: "text", text: "preserve active tail" }] },
      ])

      const removed = yield* sessions.create({ location })
      const removedActiveID = SessionMessage.ID.make("msg_lifecycle_remove_active")
      yield* activeText(bus, removed.id, removedActiveID, "remove active tail")
      yield* sessions.remove(removed.id)
      expect(yield* activeCount(db, removed.id)).toBe(0)
      expect(yield* partCount(db, removedActiveID)).toBe(0)
      expect(yield* orphanPartCount(db)).toBe(0)
    }),
  )

  it.effect("fails continuation closed until fold and transfers settled canonical JSON only", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const continuations = yield* SessionContinuation.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ parentID: parent.id })
      const parentMessageID = SessionMessage.ID.create()
      const request = continuationRequest(parent.id, child.id, parentMessageID)
      yield* SessionInbox.admit(db, bus, {
        id: request.inboxID,
        sessionID: child.id,
        item: { type: "user", payload: { text: "continue exactly" }, delivery: "steer" },
        commit: () => continuations.admit(request).pipe(Effect.orDie),
      })
      yield* SessionInbox.promoteDetailed(db, bus, child.id, "input", {
        commit: (entry) => continuations.bind({ sessionID: child.id, inboxID: entry.id }),
      })
      const bound = yield* continuations.get(request.id)
      const assistantMessageID = SessionMessage.ID.make("msg_lifecycle_continuation_active")
      yield* activeText(bus, child.id, assistantMessageID, "canonical continuation output")
      expect(
        Exit.isFailure(
          yield* continuations
            .complete({
              sessionID: child.id,
              turnID: bound?.turn?.id ?? "missing",
              assistantMessageID,
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* continuations.get(request.id)).toMatchObject({ state: "bound", turn: { state: "active" } })
      yield* end(bus, child.id, assistantMessageID)
      expect(
        yield* continuations.complete({
          sessionID: child.id,
          turnID: bound?.turn?.id ?? "missing",
          assistantMessageID,
        }),
      ).toEqual([request.id])
      expect(yield* continuations.await(request.id)).toBe("canonical continuation output")

      const transfer = yield* SessionTransfer.Service
      const source = yield* sessions.create({ location, title: "Transfer source" })
      const sourceUser = yield* sessions.prompt({ sessionID: source.id, text: "settled transfer", resume: false })
      yield* SessionInbox.promote(db, bus, source.id, "steer")
      const sourceAssistant = SessionMessage.ID.make("msg_lifecycle_transfer_active")
      yield* activeText(bus, source.id, sourceAssistant, "exclude active")
      expect((yield* transfer.export({ sessionID: source.id })).messages.map((message) => message.id)).toEqual([
        sourceUser.id,
      ])
      yield* end(bus, source.id, sourceAssistant)
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: source.id,
        assistantMessageID: sourceAssistant,
        agent: build,
        model,
      })
      expect((yield* transfer.export({ sessionID: source.id })).messages.map((message) => message.id)).toEqual([
        sourceUser.id,
      ])

      yield* end(bus, source.id, sourceAssistant)
      const exported = yield* transfer.export({ sessionID: source.id })
      const importedID = Session.ID.make("ses_lifecycle_import")
      const incompleteID = SessionMessage.ID.make("msg_lifecycle_import_incomplete")
      const importedMessages = exported.messages.map((message, index) => ({
        ...message,
        id: SessionMessage.ID.make(`msg_lifecycle_import_${index}`),
      }))
      yield* transfer.import({
        data: {
          info: { ...exported.info, id: importedID },
          messages: [
            ...importedMessages,
            SessionMessage.Assistant.make({
              id: incompleteID,
              type: "assistant",
              agent: build,
              model,
              content: [],
              time: { created: DateTime.makeUnsafe(200) },
            }),
          ],
        },
        location,
      })
      expect((yield* sessions.messages({ sessionID: importedID, order: "asc" })).map((message) => message.id)).toEqual(
        importedMessages.map((message) => message.id),
      )
      yield* assertNoSidecar(db, importedID)
    }),
  )

  it.effect("rebuilds active and folded projections and rejects divergent replay unchanged", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const created = yield* sessions.create({ location })
      yield* sessions.prompt({ sessionID: created.id, text: "replay prefix", resume: false })
      yield* SessionInbox.promote(db, bus, created.id, "steer")
      const assistantMessageID = SessionMessage.ID.make("msg_lifecycle_replay_active")
      yield* activeText(bus, created.id, assistantMessageID, "replay active tail")
      const expectedActive = yield* sessions.context(created.id)
      const activeEvents = yield* serializedEvents(db, created.id)

      yield* db.delete(SessionTable).where(eq(SessionTable.id, created.id)).run().pipe(Effect.orDie)
      yield* bus.remove(created.id)
      yield* Effect.forEach(activeEvents, (event) => bus.replay(event), { discard: true })
      expect(yield* sessions.context(created.id)).toEqual(expectedActive)
      expect(yield* activeCount(db, created.id)).toBe(1)
      expect(yield* partCount(db, assistantMessageID)).toBe(1)

      yield* end(bus, created.id, assistantMessageID)
      const expectedFolded = yield* sessions.context(created.id)
      const foldedEvents = yield* serializedEvents(db, created.id)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, created.id)).run().pipe(Effect.orDie)
      yield* bus.remove(created.id)
      yield* Effect.forEach(foldedEvents, (event) => bus.replay(event), { discard: true })
      expect(yield* sessions.context(created.id)).toEqual(expectedFolded)
      yield* assertNoSidecar(db, created.id)

      const before = yield* projectionState(db, created.id)
      const last = foldedEvents.at(-1)!
      expect(
        Exit.isFailure(yield* bus.replay({ ...last, data: { ...last.data, finish: "length" } }).pipe(Effect.exit)),
      ).toBe(true)
      expect(yield* projectionState(db, created.id)).toEqual(before)
      expect(yield* SessionHistory.load(db, created.id)).toEqual(expectedFolded)
    }),
  )
})

function activeText(
  bus: Bus.Interface,
  sessionID: Session.ID,
  assistantMessageID: SessionMessage.ID,
  text: string,
  snapshot?: Snapshot.ID,
) {
  return Effect.gen(function* () {
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model, snapshot })
    yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
    yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text })
  })
}

function end(bus: Bus.Interface, sessionID: Session.ID, assistantMessageID: SessionMessage.ID) {
  return bus.publish(SessionEvent.Step.Ended, {
    sessionID,
    assistantMessageID,
    finish: "stop",
    cost: Money.USD.make(0),
    tokens,
  })
}

function continuationRequest(
  parentSessionID: Session.ID,
  childSessionID: Session.ID,
  parentMessageID: SessionMessage.ID,
): SessionContinuation.Request {
  const identity = SessionContinuation.identity({
    parentSessionID,
    parentMessageID,
    parentToolCallID: "lifecycle-continuation",
    prompt: "continue exactly",
  })
  return {
    ...identity,
    parentSessionID,
    parentMessageID,
    parentToolCallID: "lifecycle-continuation",
    childSessionID,
    agent: "build",
    description: "lifecycle continuation",
  }
}

function insertMessage(db: Database.Interface["db"], sessionID: Session.ID, seq: number, message: SessionMessage.Info) {
  const encoded = Schema.encodeSync(SessionMessage.Info)(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({ id: SessionMessage.ID.make(id), session_id: sessionID, seq, type, time_created: seq, data })
    .run()
    .pipe(Effect.orDie)
}

function activeCount(db: Database.Interface["db"], sessionID: Session.ID) {
  return db
    .$count(SessionAssistantActiveTable, eq(SessionAssistantActiveTable.session_id, sessionID))
    .pipe(Effect.orDie)
}

function partCount(db: Database.Interface["db"], messageID: SessionMessage.ID) {
  return db.$count(SessionAssistantPartTable, eq(SessionAssistantPartTable.message_id, messageID)).pipe(Effect.orDie)
}

function messageCount(db: Database.Interface["db"], sessionID: Session.ID) {
  return db.$count(SessionMessageTable, eq(SessionMessageTable.session_id, sessionID)).pipe(Effect.orDie)
}

function orphanPartCount(db: Database.Interface["db"]) {
  return db
    .$count(
      SessionAssistantPartTable,
      sql`NOT EXISTS (SELECT 1 FROM session_assistant_active WHERE message_id = ${SessionAssistantPartTable.message_id})`,
    )
    .pipe(Effect.orDie)
}

function assertNoSidecar(db: Database.Interface["db"], sessionID: Session.ID) {
  return Effect.gen(function* () {
    expect(yield* activeCount(db, sessionID)).toBe(0)
    expect(
      yield* db
        .$count(
          SessionAssistantPartTable,
          sql`EXISTS (
            SELECT 1 FROM session_message
            WHERE session_message.id = ${SessionAssistantPartTable.message_id}
              AND session_message.session_id = ${sessionID}
          )`,
        )
        .pipe(Effect.orDie),
    ).toBe(0)
  })
}

function sidecarState(db: Database.Interface["db"], sessionID: Session.ID, messageID: SessionMessage.ID) {
  return Effect.all([
    db
      .select()
      .from(SessionAssistantActiveTable)
      .where(eq(SessionAssistantActiveTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie),
    db
      .select()
      .from(SessionAssistantPartTable)
      .where(eq(SessionAssistantPartTable.message_id, messageID))
      .orderBy(asc(SessionAssistantPartTable.position))
      .all()
      .pipe(Effect.orDie),
  ])
}

function projectionState(db: Database.Interface["db"], sessionID: Session.ID) {
  return Effect.all([
    db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).all().pipe(Effect.orDie),
    db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie),
    db
      .select()
      .from(SessionAssistantActiveTable)
      .where(eq(SessionAssistantActiveTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie),
  ])
}

function serializedEvents(db: Database.Interface["db"], sessionID: Session.ID) {
  return db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows.map(
          (row): Bus.SerializedEvent => ({
            id: Event.ID.make(row.id),
            type: row.type,
            created: row.created,
            seq: row.seq,
            aggregateID: row.aggregate_id,
            data: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(row.data),
          }),
        ),
      ),
    )
}
