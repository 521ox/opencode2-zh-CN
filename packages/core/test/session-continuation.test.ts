import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { Money } from "@opencode-ai/schema/money"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { Model } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionContinuation } from "@opencode-ai/core/session/continuation"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInbox } from "@opencode-ai/core/session/inbox"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import {
  SessionInboxTable,
  SessionMessageTable,
  SessionSubagentContinuationTable,
  SessionSubagentTurnTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const model = Model.Ref.make({ id: Model.ID.make("continuation"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionContinuation.node]), [
    [Bus.node, Bus.configured({ persist: true })],
  ]),
)

const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const continuations = yield* SessionContinuation.Service
  const parent = Session.ID.create()
  const child = Session.ID.create()
  const parentMessageID = SessionMessage.ID.create()
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values([
      {
        id: parent,
        project_id: Project.ID.global,
        slug: "parent",
        directory: "/project",
        title: "parent",
        version: "test",
      },
      {
        id: child,
        project_id: Project.ID.global,
        parent_id: parent,
        slug: "child",
        directory: "/project",
        title: "child",
        agent: "reviewer",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
  return { database, bus, continuations, parent, child, parentMessageID }
})

const request = (
  parent: Session.ID,
  child: Session.ID,
  parentMessageID: SessionMessage.ID,
  toolCallID: string,
  prompt: string,
  description = "review",
): SessionContinuation.Request => ({
  ...SessionContinuation.identity({ parentSessionID: parent, parentMessageID, parentToolCallID: toolCallID, prompt }),
  parentSessionID: parent,
  parentMessageID,
  parentToolCallID: toolCallID,
  childSessionID: child,
  agent: "reviewer",
  description,
})

const admit = (
  db: Database.Interface["db"],
  bus: Bus.Interface,
  continuations: SessionContinuation.Interface,
  input: SessionContinuation.Request,
  prompt: string,
) =>
  SessionInbox.admit(db, bus, {
    id: input.inboxID,
    sessionID: input.childSessionID,
    item: { type: "user", payload: { text: prompt }, delivery: "steer" },
    commit: () => continuations.admit(input).pipe(Effect.orDie),
  })

const deliver = (
  db: Database.Interface["db"],
  bus: Bus.Interface,
  continuations: SessionContinuation.Interface,
  sessionID: Session.ID,
) =>
  SessionInbox.promoteDetailed(db, bus, sessionID, "input", {
    commit: (entry) => continuations.bind({ sessionID, inboxID: entry.id }),
  })

const publishAssistant = (bus: Bus.Interface, sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const assistantMessageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("reviewer"),
      model,
    })
    yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
    yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text })
    yield* bus.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID,
      finish: "stop",
      cost: Money.USD.zero,
      tokens,
    })
    return assistantMessageID
  })

describe("SessionContinuation", () => {
  it.effect("rolls back new child creation, Inbox admission, and continuation admission together", () =>
    Effect.gen(function* () {
      const { database, bus, continuations, parent, parentMessageID } = yield* setup
      const child = SessionContinuation.identity({
        parentSessionID: parent,
        parentMessageID,
        parentToolCallID: "atomic-create",
        prompt: "atomic prompt",
      }).childSessionID
      const input = request(parent, child, parentMessageID, "atomic-create", "atomic prompt")
      const exit = yield* bus
        .publishAll([
          [
            SessionEvent.Created,
            {
              sessionID: child,
              projectID: Project.ID.global,
              location,
              parentID: parent,
              slug: "atomic-child",
              agent: Agent.ID.make("reviewer"),
              version: "test",
            },
          ],
          [
            SessionEvent.InboxEnqueued,
            {
              sessionID: child,
              inboxID: input.inboxID,
              item: { type: "user", payload: { text: "atomic prompt" }, delivery: "steer" },
            },
            {
              commit: () =>
                continuations
                  .admit(input)
                  .pipe(Effect.orDie, Effect.andThen(Effect.die(new Error("reject child transaction")))),
            },
          ],
        ])
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(
        yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, child)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* database.db
          .select()
          .from(SessionInboxTable)
          .where(eq(SessionInboxTable.id, input.inboxID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      expect(yield* continuations.get(input.id)).toBeUndefined()
    }),
  )

  it.effect("detects conflicting retries while preserving one deterministic request identity", () =>
    Effect.gen(function* () {
      const { database, bus, continuations, parent, child, parentMessageID } = yield* setup
      const first = request(parent, child, parentMessageID, "retry", "first prompt")
      yield* admit(database.db, bus, continuations, first, "first prompt")
      yield* admit(database.db, bus, continuations, first, "first prompt")
      const conflict = yield* admit(
        database.db,
        bus,
        continuations,
        { ...first, description: "different" },
        "changed retry prompt",
      ).pipe(Effect.exit)

      expect(Exit.isFailure(conflict)).toBe(true)
      expect(
        yield* database.db
          .select()
          .from(SessionSubagentContinuationTable)
          .where(eq(SessionSubagentContinuationTable.id, first.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("matches only the complete durable request identity without creating a continuation", () =>
    Effect.gen(function* () {
      const { database, bus, continuations, parent, child, parentMessageID } = yield* setup
      const input = request(parent, child, parentMessageID, "matches", "exact request", "exact description")
      yield* admit(database.db, bus, continuations, input, "exact request")
      expect(yield* continuations.matches(input)).toBe(true)

      const mismatches: ReadonlyArray<SessionContinuation.Request> = [
        { ...input, parentSessionID: Session.ID.create() },
        { ...input, parentMessageID: SessionMessage.ID.create() },
        { ...input, parentToolCallID: "different-tool-call" },
        { ...input, childSessionID: Session.ID.create() },
        { ...input, inboxID: SessionMessage.ID.create() },
        { ...input, agent: "fallback" },
        { ...input, description: "different description" },
        { ...input, promptDigest: "different-digest" },
      ]
      for (const conflicting of mismatches) expect(yield* continuations.matches(conflicting)).toBe(false)
      expect(
        yield* continuations.matches(request(parent, child, parentMessageID, "missing", "missing request", "missing")),
      ).toBe(false)
      expect(
        yield* database.db
          .select()
          .from(SessionSubagentContinuationTable)
          .where(eq(SessionSubagentContinuationTable.id, input.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      expect(yield* continuations.get(input.id)).toMatchObject({ state: "admitted" })
    }),
  )

  it.effect("binds exact Inbox membership and stores only the causally selected assistant final", () =>
    Effect.gen(function* () {
      const { database, bus, continuations, parent, child, parentMessageID } = yield* setup
      const oldAssistant = yield* publishAssistant(bus, child, "old assistant must not satisfy this request")
      const input = request(parent, child, parentMessageID, "exact-final", "new prompt")
      yield* admit(database.db, bus, continuations, input, "new prompt")
      expect((yield* continuations.get(input.id))?.state).toBe("admitted")

      expect((yield* deliver(database.db, bus, continuations, child)).map((entry) => entry.id)).toEqual([input.inboxID])
      const bound = yield* continuations.get(input.id)
      expect(bound).toMatchObject({ state: "bound", turn: { state: "active" } })
      expect(bound?.turn?.assistantMessageID).toBeUndefined()

      const finalAssistant = yield* publishAssistant(bus, child, "exact prompt-correlated conclusion")
      expect(finalAssistant).not.toBe(oldAssistant)
      expect(
        yield* continuations.complete({
          sessionID: child,
          turnID: bound?.turn?.id ?? "missing",
          assistantMessageID: finalAssistant,
        }),
      ).toEqual([input.id])
      expect(yield* continuations.await(input.id)).toBe("exact prompt-correlated conclusion")
      expect(yield* continuations.get(input.id)).toMatchObject({
        state: "completed",
        turn: { assistantMessageID: finalAssistant, output: "exact prompt-correlated conclusion" },
      })
      expect(
        yield* database.db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, oldAssistant))
          .get()
          .pipe(Effect.orDie),
      ).toBeDefined()
    }),
  )

  it.effect("shares a same-window turn but leaves a later successor failure attached only to its own request", () =>
    Effect.gen(function* () {
      const { database, bus, continuations, parent, child, parentMessageID } = yield* setup
      const first = request(parent, child, parentMessageID, "first", "first steer")
      const second = request(parent, child, parentMessageID, "second", "second steer")
      yield* admit(database.db, bus, continuations, first, "first steer")
      yield* admit(database.db, bus, continuations, second, "second steer")
      expect((yield* deliver(database.db, bus, continuations, child)).map((entry) => entry.id).toSorted()).toEqual(
        [first.inboxID, second.inboxID].toSorted(),
      )
      const firstBound = yield* continuations.get(first.id)
      const secondBound = yield* continuations.get(second.id)
      expect(firstBound?.turn?.id).toBe(secondBound?.turn?.id)
      const firstFinal = yield* publishAssistant(bus, child, "shared turn final")
      yield* continuations.complete({
        sessionID: child,
        turnID: firstBound?.turn?.id ?? "missing",
        assistantMessageID: firstFinal,
      })
      expect(yield* Effect.all([continuations.await(first.id), continuations.await(second.id)])).toEqual([
        "shared turn final",
        "shared turn final",
      ])

      const successor = request(parent, child, parentMessageID, "successor", "later prompt")
      yield* admit(database.db, bus, continuations, successor, "later prompt")
      yield* deliver(database.db, bus, continuations, child)
      const failed = yield* continuations.failActive({
        sessionID: child,
        error: { type: "provider.failed", message: "successor failed" },
      })
      yield* continuations.signal(failed)

      expect(yield* continuations.await(successor.id).pipe(Effect.flip)).toMatchObject({
        error: { type: "provider.failed", message: "successor failed" },
      })
      expect(yield* continuations.get(first.id)).toMatchObject({
        state: "completed",
        turn: { output: "shared turn final" },
      })
      expect(yield* continuations.get(successor.id)).toMatchObject({
        state: "failed",
        turn: { error: { type: "provider.failed", message: "successor failed" } },
      })
    }),
  )

  it.effect("returns terminal-before-subscribe and wakes a subscribed waiter without polling", () =>
    Effect.gen(function* () {
      const { database, bus, continuations, parent, child, parentMessageID } = yield* setup
      const before = request(parent, child, parentMessageID, "before", "terminal before subscribe")
      yield* admit(database.db, bus, continuations, before, "terminal before subscribe")
      yield* deliver(database.db, bus, continuations, child)
      const beforeTurn = yield* continuations.get(before.id)
      const beforeAssistant = yield* publishAssistant(bus, child, "already terminal")
      yield* continuations.complete({
        sessionID: child,
        turnID: beforeTurn?.turn?.id ?? "missing",
        assistantMessageID: beforeAssistant,
      })
      expect(yield* continuations.await(before.id)).toBe("already terminal")

      const after = request(parent, child, parentMessageID, "after", "terminal after subscribe")
      yield* admit(database.db, bus, continuations, after, "terminal after subscribe")
      yield* deliver(database.db, bus, continuations, child)
      const waiter = yield* continuations.await(after.id).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(waiter.pollUnsafe()).toBeUndefined()
      const afterTurn = yield* continuations.get(after.id)
      const afterAssistant = yield* publishAssistant(bus, child, "woken terminal")
      yield* continuations.complete({
        sessionID: child,
        turnID: afterTurn?.turn?.id ?? "missing",
        assistantMessageID: afterAssistant,
      })
      expect(yield* Fiber.join(waiter)).toBe("woken terminal")
    }),
  )

  it.effect("removes an interrupted subscriber without dropping the shared hub gate", () =>
    Effect.gen(function* () {
      const { database, bus, continuations, parent, child, parentMessageID } = yield* setup
      const input = request(parent, child, parentMessageID, "interrupted-subscriber", "interrupted subscriber")
      yield* admit(database.db, bus, continuations, input, "interrupted subscriber")
      yield* deliver(database.db, bus, continuations, child)
      const interrupted = yield* continuations.await(input.id).pipe(Effect.forkChild)
      const retained = yield* continuations.await(input.id).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(interrupted.pollUnsafe()).toBeUndefined()
      expect(retained.pollUnsafe()).toBeUndefined()

      yield* Fiber.interrupt(interrupted)
      const turn = yield* continuations.get(input.id)
      const assistant = yield* publishAssistant(bus, child, "remaining subscriber received the terminal")
      yield* continuations.complete({
        sessionID: child,
        turnID: turn?.turn?.id ?? "missing",
        assistantMessageID: assistant,
      })
      expect(yield* Fiber.join(retained)).toBe("remaining subscriber received the terminal")
    }),
  )

  it.effect("reconciles foreign-owner terminals through SQLite without replacing the local hub fast path", () =>
    Effect.gen(function* () {
      const { database, bus, continuations, parent, child, parentMessageID } = yield* setup
      const foreign = yield* SessionContinuation.make(database.db, bus)

      const terminal = request(parent, child, parentMessageID, "foreign-terminal", "foreign terminal")
      yield* admit(database.db, bus, continuations, terminal, "foreign terminal")
      yield* deliver(database.db, bus, continuations, child)
      let foreignWakeCalls = 0
      const foreignWaiter = yield* foreign
        .await(terminal.id, { foreign: { wake: Effect.sync(() => void foreignWakeCalls++) } })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(foreignWaiter.pollUnsafe()).toBeUndefined()

      const terminalTurn = yield* continuations.get(terminal.id)
      const terminalAssistant = yield* publishAssistant(bus, child, "foreign durable terminal")
      yield* continuations.complete({
        sessionID: child,
        turnID: terminalTurn?.turn?.id ?? "missing",
        assistantMessageID: terminalAssistant,
      })

      // The foreign hub owns no local gate for the writer, so it cannot learn this
      // terminal until its waiter-scoped authoritative reconciliation runs.
      expect(foreignWaiter.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("100 millis")
      expect(yield* Fiber.join(foreignWaiter)).toBe("foreign durable terminal")
      expect(foreignWakeCalls).toBe(0)

      const released = request(parent, child, parentMessageID, "foreign-release", "foreign release")
      yield* admit(database.db, bus, continuations, released, "foreign release")
      yield* deliver(database.db, bus, continuations, child)
      const reacquired = yield* Deferred.make<void>()
      let reacquireCalls = 0
      const releasedWaiter = yield* foreign
        .await(released.id, {
          foreign: {
            wake: Effect.gen(function* () {
              reacquireCalls++
              yield* Deferred.succeed(reacquired, undefined)
              const turn = yield* continuations.get(released.id)
              const assistant = yield* publishAssistant(bus, child, "reacquired exact terminal")
              yield* continuations.complete({
                sessionID: child,
                turnID: turn?.turn?.id ?? "missing",
                assistantMessageID: assistant,
              })
            }),
          },
        })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(releasedWaiter.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("100 millis")
      yield* Deferred.await(reacquired)
      expect(yield* Fiber.join(releasedWaiter)).toBe("reacquired exact terminal")
      expect(reacquireCalls).toBe(1)

      const local = request(parent, child, parentMessageID, "local-hub", "local hub")
      yield* admit(database.db, bus, continuations, local, "local hub")
      yield* deliver(database.db, bus, continuations, child)
      let localFallbackCalls = 0
      const localWaiter = yield* continuations
        .await(local.id, { foreign: { wake: Effect.sync(() => void localFallbackCalls++) } })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const localTurn = yield* continuations.get(local.id)
      const localAssistant = yield* publishAssistant(bus, child, "local hub terminal")
      yield* continuations.complete({
        sessionID: child,
        turnID: localTurn?.turn?.id ?? "missing",
        assistantMessageID: localAssistant,
      })
      expect(yield* Fiber.join(localWaiter)).toBe("local hub terminal")
      expect(localFallbackCalls).toBe(0)
    }),
  )

  it.effect("terminalizes every live child request before deletion and returns exact waiter ownership", () =>
    Effect.gen(function* () {
      const { database, bus, continuations, parent, child, parentMessageID } = yield* setup
      const bound = request(parent, child, parentMessageID, "delete-bound", "bound before child deletion")
      const admitted = request(parent, child, parentMessageID, "delete-admitted", "admitted before child deletion")
      yield* admit(database.db, bus, continuations, bound, "bound before child deletion")
      yield* deliver(database.db, bus, continuations, child)
      yield* admit(database.db, bus, continuations, admitted, "admitted before child deletion")

      const cancelled = yield* continuations.cancelChild(child)
      expect(cancelled.requestIDs.toSorted()).toEqual([bound.id, admitted.id].toSorted())
      expect(cancelled.waiterIDs.toSorted()).toEqual([bound.waiterID, admitted.waiterID].toSorted())
      expect(yield* continuations.get(bound.id)).toMatchObject({ state: "cancelled", turn: { state: "cancelled" } })
      expect(yield* continuations.get(admitted.id)).toMatchObject({ state: "cancelled" })
      expect(yield* continuations.cancelChild(child)).toEqual({ requestIDs: [], waiterIDs: [] })
    }),
  )

  it.effect("cancels only an admitted request before delivery and all members after binding", () =>
    Effect.gen(function* () {
      const { database, bus, continuations, parent, child, parentMessageID } = yield* setup
      const pending = request(parent, child, parentMessageID, "pending", "cancel before bind")
      yield* admit(database.db, bus, continuations, pending, "cancel before bind")
      expect(yield* continuations.cancel(pending.id)).toEqual({ waiterIDs: [pending.waiterID], interrupt: false })
      expect(yield* continuations.get(pending.id)).toMatchObject({ state: "cancelled" })
      expect(
        yield* database.db
          .select()
          .from(SessionInboxTable)
          .where(eq(SessionInboxTable.id, pending.inboxID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
      const pendingExit = yield* continuations.await(pending.id).pipe(Effect.exit)
      expect(Exit.isFailure(pendingExit) && Cause.hasInterruptsOnly(pendingExit.cause)).toBe(true)

      const first = request(parent, child, parentMessageID, "bound-first", "first bound")
      const second = request(parent, child, parentMessageID, "bound-second", "second bound")
      yield* admit(database.db, bus, continuations, first, "first bound")
      yield* admit(database.db, bus, continuations, second, "second bound")
      yield* deliver(database.db, bus, continuations, child)
      const cancelled = yield* continuations.cancel(first.id)
      expect(cancelled.interrupt).toBe(true)
      expect(cancelled.waiterIDs.toSorted()).toEqual([first.waiterID, second.waiterID].toSorted())
      expect(yield* continuations.get(first.id)).toMatchObject({ state: "cancelled", turn: { state: "cancelled" } })
      expect(yield* continuations.get(second.id)).toMatchObject({ state: "cancelled", turn: { state: "cancelled" } })
      expect(
        yield* database.db
          .select()
          .from(SessionSubagentTurnTable)
          .where(eq(SessionSubagentTurnTable.child_session_id, child))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "cancelled" })
      expect(yield* continuations.cancelChild(child)).toEqual({ requestIDs: [], waiterIDs: [] })
    }),
  )
})
