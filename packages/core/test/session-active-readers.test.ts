import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
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
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { SessionStats } from "@opencode-ai/core/session/stats"
import { SessionStore } from "@opencode-ai/core/session/store"
import { InstructionStateTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Money } from "@opencode-ai/schema/money"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
    [Bus.node, Bus.configured({ persist: true })],
  ]),
)
const sessionsLayer = AppNodeBuilder.build(LayerNode.group([Session.node, SessionStore.node]), [
  [SessionExecution.node, SessionExecution.noopLayer],
])
const projectID = Project.ID.make("active-readers")
const model = Model.Ref.make({ id: Model.ID.make("reader-model"), providerID: Provider.ID.make("reader-provider") })
const build = Agent.ID.make("build")
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

describe("active assistant readers", () => {
  it.effect("hydrates context, runner entries, preview boundaries, pending tools, and lowered prefixes", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      const sessionID = Session.ID.make("ses_active_reader_context")
      const assistantMessageID = SessionMessage.ID.make("msg_active_reader_context")
      yield* setup(db)
      yield* insertSession(db, sessionID)
      const user = SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_active_reader_user"),
        type: "user",
        text: "unchanged prefix",
        time: { created: DateTime.makeUnsafe(0) },
      })
      yield* insertMessage(db, sessionID, 0, user)
      yield* db
        .insert(InstructionStateTable)
        .values({ session_id: sessionID, epoch_start: 0, through_seq: 0, initial_values: {}, current_values: {} })
        .run()
        .pipe(Effect.orDie)
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID })
      yield* activeText(bus, sessionID, assistantMessageID, "active answer")
      yield* bus.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        id: "active-tool",
        name: "read",
      })
      yield* bus.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID,
        id: "active-tool",
        text: '{"path":"active"}',
      })
      yield* bus.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        id: "active-tool",
        input: { path: "active" },
        executed: true,
      })

      const oracle = SessionMessage.Assistant.make({
        id: assistantMessageID,
        type: "assistant",
        agent: build,
        model,
        content: [
          SessionMessage.AssistantText.make({ type: "text", text: "active answer" }),
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "active-tool",
            name: "read",
            executed: true,
            state: SessionMessage.ToolStateRunning.make({
              status: "running",
              input: { path: "active" },
              metadata: {},
            }),
            time: { created: DateTime.makeUnsafe(0), ran: DateTime.makeUnsafe(0) },
          }),
        ],
        time: { created: DateTime.makeUnsafe(0) },
      })
      const context = yield* SessionHistory.load(db, sessionID)
      const assistant = context.at(-1)
      expect(assistant).toEqual(oracle)
      const runner = yield* SessionHistory.entriesForRunner(db, sessionID, [])
      expect(runner.entries.map((entry) => entry.message)).toEqual(context)
      const store = yield* SessionStore.Service
      expect(yield* store.context(sessionID)).toEqual(context)
      expect(yield* SessionHistory.preview(db, sessionID, [])).toMatchObject({ messages: [user] })
      expect(yield* SessionHistory.pendingToolCalls(db, sessionID)).toMatchObject([
        { assistantMessageID, tool: { id: "active-tool", executed: true, state: { status: "running" } } },
      ])
      expect(JSON.stringify(toLLMMessages(context, model))).toBe(JSON.stringify(toLLMMessages([user, oracle], model)))

      const legacy = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_active_reader_legacy"),
        type: "assistant",
        agent: build,
        model,
        content: [
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "legacy-tool",
            name: "shell",
            state: SessionMessage.ToolStateStreaming.make({ status: "streaming", input: "pwd" }),
            time: { created: DateTime.makeUnsafe(0) },
          }),
        ],
        time: { created: DateTime.makeUnsafe(0) },
      })
      yield* insertMessage(db, sessionID, 100, legacy)
      expect((yield* SessionHistory.pendingToolCalls(db, sessionID)).map((item) => item.tool.id)).toEqual([
        "active-tool",
        "legacy-tool",
      ])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("hydrates previous assistants across active and settled remote-compaction boundaries", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* setup(db)
      for (const state of ["active", "settled"] as const) {
        const sessionID = Session.ID.make(`ses_previous_${state}`)
        const assistantMessageID = SessionMessage.ID.make(`msg_previous_${state}`)
        yield* insertSession(db, sessionID)
        yield* activeText(bus, sessionID, assistantMessageID, `${state} previous`)
        if (state === "settled")
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.make(0),
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
        yield* insertMessage(
          db,
          sessionID,
          100,
          SessionMessage.CompactionCompleted.make({
            id: SessionMessage.ID.make(`msg_compaction_${state}`),
            type: "compaction",
            status: "completed",
            reason: "auto",
            summary: "",
            recent: "",
            remote: [],
            time: { created: DateTime.makeUnsafe(1) },
          }),
        )
        expect(yield* SessionHistory.load(db, sessionID)).toMatchObject([{ type: "compaction", status: "completed" }])
      }
    }),
  )

  it.effect("hydrates Store and public single-message and pagination boundaries", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      const sessionID = Session.ID.make("ses_active_reader_pages")
      const assistantMessageID = SessionMessage.ID.make("msg_active_reader_pages")
      yield* setup(db)
      yield* insertSession(db, sessionID)
      const user = SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_active_reader_page_user"),
        type: "user",
        text: "page one",
        time: { created: DateTime.makeUnsafe(0) },
      })
      yield* insertMessage(db, sessionID, 0, user)
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID })
      yield* activeText(bus, sessionID, assistantMessageID, "page two active")

      const store = yield* SessionStore.Service
      expect(yield* store.message(assistantMessageID)).toMatchObject({
        sessionID,
        message: { content: [{ type: "text", text: "page two active" }] },
      })
      const sessions = yield* Session.Service
      expect(yield* sessions.message({ sessionID, messageID: assistantMessageID })).toMatchObject({
        content: [{ type: "text", text: "page two active" }],
      })
      const first = yield* sessions.messages({ sessionID, order: "asc", limit: 1 })
      expect(first).toEqual([user])
      const next = yield* sessions.messages({
        sessionID,
        order: "asc",
        limit: 1,
        cursor: { id: user.id, direction: "next" },
      })
      expect(next).toMatchObject([{ id: assistantMessageID, content: [{ text: "page two active" }] }])
      expect(
        yield* sessions.messages({
          sessionID,
          order: "asc",
          limit: 1,
          cursor: { id: assistantMessageID, direction: "previous" },
        }),
      ).toEqual([user])
      expect(yield* sessions.messages({ sessionID, order: "desc", limit: 1 })).toMatchObject([
        { id: assistantMessageID, content: [{ text: "page two active" }] },
      ])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("batches concurrent active Sessions into Stats without double counting tools", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* setup(db)
      for (const [index, name] of ["read", "shell"].entries()) {
        const sessionID = Session.ID.make(`ses_active_stats_${index}`)
        const assistantMessageID = SessionMessage.ID.make(`msg_active_stats_${index}`)
        yield* insertSession(db, sessionID)
        yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model })
        yield* bus.publish(SessionEvent.Tool.Input.Started, {
          sessionID,
          assistantMessageID,
          id: `tool-${index}`,
          name,
        })
        yield* bus.publish(SessionEvent.Tool.Input.Ended, {
          sessionID,
          assistantMessageID,
          id: `tool-${index}`,
          text: "{}",
        })
        yield* bus.publish(SessionEvent.Tool.Called, {
          sessionID,
          assistantMessageID,
          id: `tool-${index}`,
          input: {},
          executed: true,
        })
      }

      const stats = yield* SessionStats.get({ from: 0, to: 1, projectID, timezone: "UTC", tools: "detail" })
      expect(stats.sessions).toBe(2)
      expect(stats.steps).toBe(2)
      expect(stats.models).toMatchObject([{ steps: 2 }])
      expect(stats.tools).toMatchObject({
        mode: "detail",
        totals: { calls: 2, succeeded: 0, failed: 0, unfinished: 2 },
        usage: [
          { name: "read", calls: 1, unfinished: 1 },
          { name: "shell", calls: 1, unfinished: 1 },
        ],
      })
    }),
  )

  it.effect("preserves legacy incomplete JSON when no active head exists", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = Session.ID.make("ses_active_reader_legacy_only")
      yield* setup(db)
      yield* insertSession(db, sessionID)
      const legacy = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_active_reader_legacy_only"),
        type: "assistant",
        agent: build,
        model,
        content: [{ type: "text", text: "legacy complete JSON" }],
        time: { created: DateTime.makeUnsafe(0) },
      })
      yield* insertMessage(db, sessionID, 0, legacy)
      expect(yield* SessionHistory.load(db, sessionID)).toEqual([legacy])
      const store = yield* SessionStore.Service
      expect((yield* store.message(legacy.id))?.message).toEqual(legacy)
      const sessions = yield* Session.Service
      expect(yield* sessions.messages({ sessionID })).toEqual([legacy])
    }).pipe(Effect.provide(sessionsLayer)),
  )
})

function setup(db: Database.Interface["db"]) {
  return db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/active-readers"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
}

function insertSession(db: Database.Interface["db"], sessionID: Session.ID) {
  return db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: projectID,
      slug: sessionID,
      directory: "/active-readers",
      title: sessionID,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
}

function insertMessage(db: Database.Interface["db"], sessionID: Session.ID, seq: number, message: SessionMessage.Info) {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: sessionID,
      seq,
      type,
      time_created: encoded.time.created,
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

function activeText(bus: Bus.Interface, sessionID: Session.ID, assistantMessageID: SessionMessage.ID, text: string) {
  return Effect.gen(function* () {
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model })
    yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
    yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text })
  })
}
