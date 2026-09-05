import { describe, expect } from "bun:test"
import path from "node:path"
import { asc, eq, sql } from "drizzle-orm"
import { Effect, Exit, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
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
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const points = [
  "Step.Started",
  "Tool.Input.Started",
  "Tool.Input.Ended",
  "Tool.Called",
  "Tool.Success",
  "terminal commit",
  "terminal transaction abort",
] as const
const model = Model.Ref.make({ id: Model.ID.make("restart-model"), providerID: Provider.ID.make("restart") })

type Point = (typeof points)[number]
type Fixture = ReturnType<typeof identity>
type RunResult = Effect.Success<ReturnType<typeof runEvents>>

describe("SessionProjector file-SQLite restart", () => {
  it.effect(
    "matches uninterrupted projection at all seven fresh-layer boundaries",
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const target = AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
        [Database.node, Database.configured({ path: path.join(tmp.path, "restart.sqlite") })],
        [Bus.node, Bus.configured({ persist: true })],
      ])

      const first = yield* Effect.gen(function* () {
        yield* TestClock.setTime(1_000)
        const db = (yield* Database.Service).db
        const bus = yield* Bus.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* createAudit(db)
        return yield* Effect.forEach(points, (point) => prepare(db, bus, point), { concurrency: 1 })
      }).pipe(Effect.provide(Layer.fresh(target)))

      const second = yield* Effect.gen(function* () {
        yield* TestClock.setTime(1_000)
        const db = (yield* Database.Service).db
        const bus = yield* Bus.Service
        yield* createAudit(db)
        return yield* Effect.forEach(points, (point, index) => finish(db, bus, point, first[index]), {
          concurrency: 1,
        })
      }).pipe(Effect.provide(Layer.fresh(target)))

      for (const [index, point] of points.entries()) {
        const result = second[index]
        expect(result.restart, point).toEqual(result.control)
        expect(result.restart.messageBytes, point).toBe(result.control.messageBytes)
        expect(result.restart.active, point).toHaveLength(0)
        expect(result.restart.parts, point).toHaveLength(0)
        expect(result.counts.preterminal, point).toBe(0)
        expect(result.counts.terminal, point).toBe(1)
        expect(result.counts.supersession, point).toBeLessThanOrEqual(1)
        if (point === "terminal commit") expect(result.counts.replayedTerminal).toBe(0)
      }
    }),
    30_000,
  )
})

function identity(kind: "control" | "restart", point: Point) {
  const suffix = point.replaceAll(/[^a-z]+/gi, "_").toLowerCase()
  return {
    sessionID: Session.ID.make(`ses_${kind}_${suffix}`),
    messageID: SessionMessage.ID.make(`msg_${kind}_${suffix}`),
    eventID: (index: number) => Event.ID.make(`evt_${kind}_${suffix}_${index}`),
  }
}

function prepare(db: Database.Interface["db"], bus: Bus.Interface, point: Point) {
  return Effect.gen(function* () {
    const control = identity("control", point)
    const restart = identity("restart", point)
    yield* insertSession(db, control.sessionID)
    yield* insertSession(db, restart.sessionID)
    const controlResult =
      point === "terminal transaction abort"
        ? yield* abortThenRetry(db, bus, control)
        : yield* runEvents(db, bus, control, 0, 6, false)
    const split = point === "terminal transaction abort" ? 6 : points.indexOf(point) + 1
    const restartResult =
      point === "terminal transaction abort"
        ? yield* abortOnly(db, bus, restart)
        : yield* runEvents(db, bus, restart, 0, split, false)
    return { control, restart, split, controlResult, restartResult, committedTerminal: restartResult.event }
  })
}

function abortOnly(db: Database.Interface["db"], bus: Bus.Interface, fixture: Fixture) {
  return Effect.gen(function* () {
    const prefix = yield* runEvents(db, bus, fixture, 0, 5, false)
    const before = yield* state(db, fixture)
    const aborted = yield* runEvents(db, bus, fixture, 5, 6, true)
    expect(aborted.aborted).toBeTrue()
    expect(yield* state(db, fixture)).toEqual(before)
    return merge(prefix, aborted)
  })
}

function abortThenRetry(db: Database.Interface["db"], bus: Bus.Interface, fixture: Fixture) {
  return Effect.gen(function* () {
    const aborted = yield* abortOnly(db, bus, fixture)
    return merge(aborted, yield* runEvents(db, bus, fixture, 5, 6, false))
  })
}

function finish(
  db: Database.Interface["db"],
  bus: Bus.Interface,
  point: Point,
  first: Effect.Success<ReturnType<typeof prepare>>,
) {
  return Effect.gen(function* () {
    const resumed =
      point === "terminal commit"
        ? yield* replayTerminal(db, bus, first.committedTerminal)
        : yield* runEvents(db, bus, first.restart, point === "terminal transaction abort" ? 5 : first.split, 6, false)
    return {
      control: yield* snapshot(db, first.control),
      restart: yield* snapshot(db, first.restart),
      counts: {
        preterminal: first.restartResult.preterminal + resumed.preterminal,
        terminal: first.restartResult.terminal + resumed.terminal,
        supersession: 0,
        replayedTerminal: resumed.replayed,
      },
    }
  })
}

function runEvents(
  db: Database.Interface["db"],
  bus: Bus.Interface,
  fixture: Fixture,
  from: number,
  to: number,
  abort: boolean,
) {
  return Effect.gen(function* () {
    let preterminal = 0
    let terminal = 0
    let aborted = false
    let event: Bus.SerializedEvent | undefined
    for (let index = from; index < to; index++) {
      yield* clearAudit(db)
      const exit = yield* publish(bus, fixture, index, abort && index === 5).pipe(Effect.exit)
      const updates = yield* fullUpdates(db, fixture.messageID)
      expect(yield* activeCount(db, fixture.sessionID)).toBeLessThanOrEqual(1)
      if (index < 5) preterminal += updates
      if (Exit.isSuccess(exit) && index === 5) {
        terminal += updates
        event = serialized(exit.value)
      }
      if (Exit.isFailure(exit)) {
        expect(index).toBe(5)
        expect(updates).toBe(0)
        aborted = true
      }
    }
    return { preterminal, terminal, aborted, event, replayed: 0 }
  })
}

function merge(first: RunResult, second: RunResult): RunResult {
  return {
    preterminal: first.preterminal + second.preterminal,
    terminal: first.terminal + second.terminal,
    aborted: first.aborted || second.aborted,
    event: second.event ?? first.event,
    replayed: first.replayed + second.replayed,
  }
}

function replayTerminal(db: Database.Interface["db"], bus: Bus.Interface, event: Bus.SerializedEvent | undefined) {
  return Effect.gen(function* () {
    if (!event) return yield* Effect.die(new Error("Missing committed terminal event"))
    yield* clearAudit(db)
    yield* bus.replay(event)
    return {
      preterminal: 0,
      terminal: 0,
      aborted: false,
      event,
      replayed: yield* fullUpdates(db, SessionMessage.ID.make(String(event.data.assistantMessageID))),
    }
  })
}

function publish(bus: Bus.Interface, fixture: Fixture, index: number, abort: boolean) {
  return Effect.gen(function* () {
    const options = { id: fixture.eventID(index), ...(abort ? { commit: () => Effect.die("terminal abort") } : {}) }
    if (index === 0)
      return yield* bus.publish(
        SessionEvent.Step.Started,
        {
          sessionID: fixture.sessionID,
          assistantMessageID: fixture.messageID,
          agent: Agent.ID.make("build"),
          model,
        },
        options,
      )
    if (index === 1)
      return yield* bus.publish(
        SessionEvent.Tool.Input.Started,
        {
          sessionID: fixture.sessionID,
          assistantMessageID: fixture.messageID,
          id: "restart-tool",
          name: "subagent",
        },
        options,
      )
    if (index === 2)
      return yield* bus.publish(
        SessionEvent.Tool.Input.Ended,
        {
          sessionID: fixture.sessionID,
          assistantMessageID: fixture.messageID,
          id: "restart-tool",
          text: '{"agent":"general"}',
        },
        options,
      )
    if (index === 3)
      return yield* bus.publish(
        SessionEvent.Tool.Called,
        {
          sessionID: fixture.sessionID,
          assistantMessageID: fixture.messageID,
          id: "restart-tool",
          input: { agent: "general" },
          executed: true,
        },
        options,
      )
    if (index === 4)
      return yield* bus.publish(
        SessionEvent.Tool.Success,
        {
          sessionID: fixture.sessionID,
          assistantMessageID: fixture.messageID,
          id: "restart-tool",
          content: [{ type: "text", text: "settled" }],
          metadata: { sessionID: "ses_restart_child", private: "preserved" },
          executed: true,
        },
        options,
      )
    return yield* bus.publish(
      SessionEvent.Step.Ended,
      {
        sessionID: fixture.sessionID,
        assistantMessageID: fixture.messageID,
        finish: "stop",
        cost: Money.USD.make(1.5),
        tokens: { input: 7, output: 5, reasoning: 3, cache: { read: 2, write: 1 } },
      },
      options,
    )
  })
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

function state(db: Database.Interface["db"], fixture: Fixture) {
  return Effect.all([
    db.select().from(SessionTable).where(eq(SessionTable.id, fixture.sessionID)).all().pipe(Effect.orDie),
    db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, fixture.sessionID))
      .all()
      .pipe(Effect.orDie),
    db
      .select()
      .from(SessionAssistantActiveTable)
      .where(eq(SessionAssistantActiveTable.session_id, fixture.sessionID))
      .all()
      .pipe(Effect.orDie),
    db
      .select()
      .from(SessionAssistantPartTable)
      .where(eq(SessionAssistantPartTable.message_id, fixture.messageID))
      .all()
      .pipe(Effect.orDie),
    db
      .select()
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, fixture.sessionID))
      .all()
      .pipe(Effect.orDie),
    db.select().from(EventTable).where(eq(EventTable.aggregate_id, fixture.sessionID)).all().pipe(Effect.orDie),
  ])
}

function snapshot(db: Database.Interface["db"], fixture: Fixture) {
  return Effect.gen(function* () {
    const messages = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, fixture.sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    const typed = yield* SessionMessageProjection.hydrate(db, messages)
    const normalize = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll(fixture.sessionID, "<session>")
          .replaceAll(fixture.messageID, "<message>")
          .replaceAll(/evt_(control|restart)_[a-z_]+_(\d+)/g, "<event-$2>"),
      )
    return normalize({
      messages: messages.map(({ time_updated: _timeUpdated, ...row }) => row),
      messageBytes: messages.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row.data)), 0),
      typed: Schema.encodeSync(Schema.Array(SessionMessage.Info))(typed),
      active: yield* db
        .select()
        .from(SessionAssistantActiveTable)
        .where(eq(SessionAssistantActiveTable.session_id, fixture.sessionID))
        .all()
        .pipe(Effect.orDie),
      parts: yield* db
        .select()
        .from(SessionAssistantPartTable)
        .where(eq(SessionAssistantPartTable.message_id, fixture.messageID))
        .orderBy(asc(SessionAssistantPartTable.position))
        .all()
        .pipe(Effect.orDie),
      sequence: yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, fixture.sessionID))
        .all()
        .pipe(Effect.orDie),
      events: yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, fixture.sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
      usage: yield* db
        .select({
          cost: SessionTable.cost,
          input: SessionTable.tokens_input,
          output: SessionTable.tokens_output,
          reasoning: SessionTable.tokens_reasoning,
          cacheRead: SessionTable.tokens_cache_read,
          cacheWrite: SessionTable.tokens_cache_write,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, fixture.sessionID))
        .get()
        .pipe(Effect.orDie),
    })
  })
}

function serialized(event: Event.Payload): Bus.SerializedEvent {
  if (!event.durable) throw new Error("Expected durable event")
  return {
    id: event.id,
    created: event.created ?? 0,
    aggregateID: event.durable.aggregateID,
    seq: event.durable.seq,
    type: Bus.versionedType(event.type, event.durable.version),
    data: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(event.data),
  }
}

function createAudit(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db.run(sql`CREATE TEMP TABLE restart_update_audit (message_id TEXT NOT NULL)`)
    yield* db.run(
      sql.raw(
        `CREATE TEMP TRIGGER restart_session_message_update AFTER UPDATE ON session_message BEGIN INSERT INTO restart_update_audit(message_id) VALUES (NEW.id); END`,
      ),
    )
  })
}

function clearAudit(db: Database.Interface["db"]) {
  return db.run(sql`DELETE FROM temp.restart_update_audit`).pipe(Effect.orDie)
}

function fullUpdates(db: Database.Interface["db"], messageID: SessionMessage.ID) {
  return db
    .get<{
      count: number
    }>(sql`SELECT count(*) AS count FROM temp.restart_update_audit WHERE message_id = ${messageID}`)
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.count ?? 0),
    )
}

function activeCount(db: Database.Interface["db"], sessionID: Session.ID) {
  return db.$count(SessionAssistantActiveTable, eq(SessionAssistantActiveTable.session_id, sessionID))
}
