export * as SessionContinuation from "./continuation.js"

import { createHash, randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { Context, Deferred, Duration, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable, SessionSubagentContinuationTable, SessionSubagentTurnTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

export type State = "requested" | "admitted" | "bound" | "completed" | "failed" | "cancelled"
export type TurnState = "active" | "completed" | "failed" | "cancelled"

export type Identity = {
  readonly id: string
  readonly childSessionID: SessionSchema.ID
  readonly inboxID: SessionMessage.ID
  readonly waiterID: string
  readonly promptDigest: string
}

export type Request = Identity & {
  readonly parentSessionID: SessionSchema.ID
  readonly parentMessageID: SessionMessage.ID
  readonly parentToolCallID: string
  readonly childSessionID: SessionSchema.ID
  readonly agent: string
  readonly description: string
}

export type Turn = {
  readonly id: string
  readonly childSessionID: SessionSchema.ID
  readonly state: TurnState
  readonly assistantMessageID?: SessionMessage.ID
  readonly output?: string
  readonly error?: { readonly type: string; readonly message: string }
}

export type Snapshot = {
  readonly request: Request
  readonly state: State
  readonly turn?: Turn
}

export type Cancellation = {
  readonly waiterIDs: ReadonlyArray<string>
  readonly interrupt: boolean
}

/** Exact private requests terminalized before their child Session is deleted. */
export type ChildCancellation = {
  readonly requestIDs: ReadonlyArray<string>
  readonly waiterIDs: ReadonlyArray<string>
}

/** A waiter-owned ordinary wake used only after an initial foreign lease result. */
export type ForeignReconcile<E = never> = {
  readonly wake: Effect.Effect<void, E>
}

export type AwaitOptions<E = never> = {
  readonly foreign?: ForeignReconcile<E>
}

export class ConflictError extends Schema.TaggedError<ConflictError>()("SessionContinuation.ConflictError", {
  id: Schema.String,
  message: Schema.String,
}) {}

export class FailedError extends Schema.TaggedError<FailedError>()("SessionContinuation.FailedError", {
  id: Schema.String,
  error: Schema.Struct({ type: Schema.String, message: Schema.String }),
}) {}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

export const identity = (input: {
  readonly parentSessionID: SessionSchema.ID
  readonly parentMessageID: SessionMessage.ID
  readonly parentToolCallID: string
  readonly prompt: string
}): Identity => {
  const request = hash([input.parentSessionID, input.parentMessageID, input.parentToolCallID].join("\u0000"))
  const id = `sc_${request}`
  return {
    id,
    childSessionID: SessionSchema.ID.make(`ses_subagent_${request}`),
    inboxID: SessionMessage.ID.make(`msg_subagent_${request}`),
    waiterID: `subagent-continuation:${id}`,
    promptDigest: hash(input.prompt),
  }
}

export const waiterID = (id: string) => `subagent-continuation:${id}`

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)

const toRequest = (row: typeof SessionSubagentContinuationTable.$inferSelect): Request => ({
  id: row.id,
  parentSessionID: SessionSchema.ID.make(row.parent_session_id),
  parentMessageID: SessionMessage.ID.make(row.parent_message_id),
  parentToolCallID: row.parent_tool_call_id,
  childSessionID: SessionSchema.ID.make(row.child_session_id),
  agent: row.agent,
  description: row.description,
  inboxID: SessionMessage.ID.make(row.inbox_id),
  waiterID: waiterID(row.id),
  promptDigest: row.prompt_digest,
})

const toTurn = (row: typeof SessionSubagentTurnTable.$inferSelect): Turn => ({
  id: row.id,
  childSessionID: SessionSchema.ID.make(row.child_session_id),
  state: row.state,
  ...(row.assistant_message_id ? { assistantMessageID: SessionMessage.ID.make(row.assistant_message_id) } : {}),
  ...(row.output !== null ? { output: row.output } : {}),
  ...(row.error !== null ? { error: row.error } : {}),
})

const sameRequest = (row: typeof SessionSubagentContinuationTable.$inferSelect, request: Request) =>
  row.parent_session_id === request.parentSessionID &&
  row.parent_message_id === request.parentMessageID &&
  row.parent_tool_call_id === request.parentToolCallID &&
  row.child_session_id === request.childSessionID &&
  row.agent === request.agent &&
  row.description === request.description &&
  row.inbox_id === request.inboxID &&
  row.prompt_digest === request.promptDigest

const terminal = (state: State) => state === "completed" || state === "failed" || state === "cancelled"

export interface Interface {
  /** Commits one request correlation from the InboxEnqueued transaction. */
  readonly admit: (request: Request) => Effect.Effect<void, ConflictError>
  /** Commits exact InboxDelivered membership from the delivery transaction. */
  readonly bind: (input: {
    readonly sessionID: SessionSchema.ID
    readonly inboxID: SessionMessage.ID
  }) => Effect.Effect<void>
  /** Returns the current request and its exact private turn, if any. */
  readonly get: (id: string) => Effect.Effect<Snapshot | undefined>
  /** Returns whether this invocation owns the full durable request identity without creating or changing it. */
  readonly matches: (request: Request) => Effect.Effect<boolean>
  /** Finds a currently active private turn for one child Session. */
  readonly active: (sessionID: SessionSchema.ID) => Effect.Effect<Turn | undefined>
  /** Stores the exact final assistant text after runner post-step policy succeeds. */
  readonly complete: (input: {
    readonly sessionID: SessionSchema.ID
    readonly turnID: string
    readonly assistantMessageID: SessionMessage.ID
  }) => Effect.Effect<ReadonlyArray<string>>
  /** Runs inside Execution.Failed's durable commit. Call signal only after the event commits. */
  readonly failActive: (input: {
    readonly sessionID: SessionSchema.ID
    readonly error: { readonly type: string; readonly message: string }
  }) => Effect.Effect<ReadonlyArray<string>>
  /** Runs inside a user interruption terminal commit. Call signal only after the event commits. */
  readonly cancelActive: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<string>>
  /** Cancels this request alone before delivery or every member of its bound turn. */
  readonly cancel: (id: string) => Effect.Effect<Cancellation, ConflictError>
  /** Terminalizes every live request for a child before Session deletion cascades its private rows. */
  readonly cancelChild: (sessionID: SessionSchema.ID) => Effect.Effect<ChildCancellation>
  /** Resolves only this request's immutable terminal outcome. */
  readonly await: <E = never>(id: string, options?: AwaitOptions<E>) => Effect.Effect<string, FailedError | E>
  /** Wakes process-local request waiters after their SQLite terminal write commits. */
  readonly signal: (ids: ReadonlyArray<string>) => Effect.Effect<void>
  /** Refuses a successful execution terminal while a continuation turn remains active. */
  readonly assertSettled: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionContinuation") {}

const FOREIGN_RECONCILE_INITIAL_DELAY = 100
const FOREIGN_RECONCILE_MAX_DELAY = 1_000
type Gate = {
  readonly deferred: Deferred.Deferred<void>
  subscribers: number
}

/** Creates one process-local wake hub over the shared authoritative SQLite store. */
export const make = (db: DatabaseService, bus: Bus.Interface): Effect.Effect<Interface> =>
  Effect.sync(() => {
    const gates = new Map<string, Gate>()

    const registerGate = (id: string) => {
      const gate = gates.get(id) ?? { deferred: Deferred.makeUnsafe<void>(), subscribers: 0 }
      gate.subscribers++
      gates.set(id, gate)
      return gate
    }

    const releaseGate = (id: string, gate: Gate) =>
      Effect.sync(() => {
        // A late waiter must not remove a newer generation registered after a signal.
        if (gates.get(id) !== gate) return
        gate.subscribers--
        if (gate.subscribers === 0) gates.delete(id)
      })

    const settleGate = (id: string, gate: Gate) =>
      Effect.gen(function* () {
        if (gates.get(id) !== gate) return
        gates.delete(id)
        yield* Deferred.succeed(gate.deferred, undefined).pipe(Effect.ignore)
      })

    const load = Effect.fn("SessionContinuation.get")(function* (id: string) {
      const continuation = yield* db
        .select()
        .from(SessionSubagentContinuationTable)
        .where(eq(SessionSubagentContinuationTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!continuation) return undefined
      const turn = continuation.turn_id
        ? yield* db
            .select()
            .from(SessionSubagentTurnTable)
            .where(eq(SessionSubagentTurnTable.id, continuation.turn_id))
            .get()
            .pipe(Effect.orDie)
        : undefined
      return {
        request: toRequest(continuation),
        state: continuation.state,
        ...(turn ? { turn: toTurn(turn) } : {}),
      } satisfies Snapshot
    })

    const matches: Interface["matches"] = Effect.fn("SessionContinuation.matches")(function* (request) {
      const row = yield* db
        .select()
        .from(SessionSubagentContinuationTable)
        .where(eq(SessionSubagentContinuationTable.id, request.id))
        .get()
        .pipe(Effect.orDie)
      return row !== undefined && sameRequest(row, request)
    })

    const signal: Interface["signal"] = Effect.fn("SessionContinuation.signal")((ids) =>
      Effect.forEach(
        [...new Set(ids)],
        (id) =>
          Effect.gen(function* () {
            const gate = gates.get(id)
            if (!gate) return
            gates.delete(id)
            yield* Deferred.succeed(gate.deferred, undefined).pipe(Effect.ignore)
          }),
        { discard: true },
      ),
    )

    const admit: Interface["admit"] = Effect.fn("SessionContinuation.admit")(function* (request) {
      const existing = yield* db
        .select()
        .from(SessionSubagentContinuationTable)
        .where(eq(SessionSubagentContinuationTable.id, request.id))
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        if (sameRequest(existing, request)) return
        return yield* new ConflictError({
          id: request.id,
          message: "Continuation identity was reused with different input",
        })
      }
      const inserted = yield* db
        .insert(SessionSubagentContinuationTable)
        .values({
          id: request.id,
          parent_session_id: request.parentSessionID,
          parent_message_id: request.parentMessageID,
          parent_tool_call_id: request.parentToolCallID,
          child_session_id: request.childSessionID,
          agent: request.agent,
          description: request.description,
          inbox_id: request.inboxID,
          state: "admitted",
          prompt_digest: request.promptDigest,
        })
        .onConflictDoNothing()
        .returning({ id: SessionSubagentContinuationTable.id })
        .get()
        .pipe(Effect.orDie)
      if (inserted) return
      const raced = yield* db
        .select()
        .from(SessionSubagentContinuationTable)
        .where(eq(SessionSubagentContinuationTable.id, request.id))
        .get()
        .pipe(Effect.orDie)
      if (raced && sameRequest(raced, request)) return
      return yield* new ConflictError({ id: request.id, message: "Continuation admission conflicted" })
    })

    const active: Interface["active"] = Effect.fn("SessionContinuation.active")(function* (sessionID) {
      const row = yield* db
        .select()
        .from(SessionSubagentTurnTable)
        .where(
          and(eq(SessionSubagentTurnTable.child_session_id, sessionID), eq(SessionSubagentTurnTable.state, "active")),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? toTurn(row) : undefined
    })

    const bind: Interface["bind"] = Effect.fn("SessionContinuation.bind")(function* (input) {
      const continuation = yield* db
        .select()
        .from(SessionSubagentContinuationTable)
        .where(eq(SessionSubagentContinuationTable.inbox_id, input.inboxID))
        .get()
        .pipe(Effect.orDie)
      if (!continuation || continuation.child_session_id !== input.sessionID) return
      if (continuation.state === "bound" || terminal(continuation.state)) return
      if (continuation.state !== "admitted")
        return yield* Effect.die(new Error(`Unexpected continuation state ${continuation.state} during delivery`))

      const current = yield* active(input.sessionID)
      const turnID = current?.id ?? `sturn_${randomUUID().replaceAll("-", "")}`
      if (!current)
        yield* db
          .insert(SessionSubagentTurnTable)
          .values({ id: turnID, child_session_id: input.sessionID, state: "active" })
          .run()
          .pipe(Effect.orDie)
      const updated = yield* db
        .update(SessionSubagentContinuationTable)
        .set({ state: "bound", turn_id: turnID })
        .where(
          and(
            eq(SessionSubagentContinuationTable.id, continuation.id),
            eq(SessionSubagentContinuationTable.state, "admitted"),
          ),
        )
        .returning({ id: SessionSubagentContinuationTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated)
        return yield* Effect.die(new Error(`Continuation ${continuation.id} changed while binding delivery`))
    })

    const terminalMembers = Effect.fn("SessionContinuation.terminalMembers")(function* (
      turnID: string,
      state: Extract<State, "completed" | "failed" | "cancelled">,
      now: number,
    ) {
      const rows = yield* db
        .update(SessionSubagentContinuationTable)
        .set({ state, time_terminal: now })
        .where(
          and(
            eq(SessionSubagentContinuationTable.turn_id, turnID),
            eq(SessionSubagentContinuationTable.state, "bound"),
          ),
        )
        .returning({ id: SessionSubagentContinuationTable.id })
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => row.id)
    })

    const complete: Interface["complete"] = Effect.fn("SessionContinuation.complete")(function* (input) {
      const ids = yield* db
        .transaction(() =>
          Effect.gen(function* () {
            const turn = yield* db
              .select()
              .from(SessionSubagentTurnTable)
              .where(
                and(
                  eq(SessionSubagentTurnTable.id, input.turnID),
                  eq(SessionSubagentTurnTable.child_session_id, input.sessionID),
                  eq(SessionSubagentTurnTable.state, "active"),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!turn) return []
            const row = yield* db
              .select()
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.id, input.assistantMessageID),
                  eq(SessionMessageTable.session_id, input.sessionID),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* Effect.die(new Error(`Final assistant ${input.assistantMessageID} is missing`))
            const message = decodeMessage({ ...row.data, id: row.id, type: row.type })
            if (message.type !== "assistant" || message.time.completed === undefined || message.error !== undefined)
              return yield* Effect.die(
                new Error(`Final assistant ${input.assistantMessageID} is not a successful terminal`),
              )
            const output = message.content
              .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
              .map((part) => part.text)
              .join("")
            const now = Date.now()
            const settled = yield* db
              .update(SessionSubagentTurnTable)
              .set({
                state: "completed",
                assistant_message_id: input.assistantMessageID,
                output,
                time_terminal: now,
              })
              .where(and(eq(SessionSubagentTurnTable.id, input.turnID), eq(SessionSubagentTurnTable.state, "active")))
              .returning({ id: SessionSubagentTurnTable.id })
              .get()
              .pipe(Effect.orDie)
            if (!settled) return []
            return yield* terminalMembers(input.turnID, "completed", now)
          }),
        )
        .pipe(Effect.orDie)
      yield* signal(ids)
      return ids
    })

    const failActive: Interface["failActive"] = Effect.fn("SessionContinuation.failActive")(function* (input) {
      const turn = yield* active(input.sessionID)
      if (!turn) return []
      const now = Date.now()
      const settled = yield* db
        .update(SessionSubagentTurnTable)
        .set({ state: "failed", error: input.error, time_terminal: now })
        .where(and(eq(SessionSubagentTurnTable.id, turn.id), eq(SessionSubagentTurnTable.state, "active")))
        .returning({ id: SessionSubagentTurnTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!settled) return []
      return yield* terminalMembers(turn.id, "failed", now)
    })

    const cancelActive: Interface["cancelActive"] = Effect.fn("SessionContinuation.cancelActive")(
      function* (sessionID) {
        const turn = yield* active(sessionID)
        if (!turn) return []
        const now = Date.now()
        const settled = yield* db
          .update(SessionSubagentTurnTable)
          .set({ state: "cancelled", time_terminal: now })
          .where(and(eq(SessionSubagentTurnTable.id, turn.id), eq(SessionSubagentTurnTable.state, "active")))
          .returning({ id: SessionSubagentTurnTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!settled) return []
        return yield* terminalMembers(turn.id, "cancelled", now)
      },
    )

    const cancelPending = Effect.fn("SessionContinuation.cancelPending")(function* (id: string) {
      const now = Date.now()
      const cancelled = yield* db
        .update(SessionSubagentContinuationTable)
        .set({ state: "cancelled", time_terminal: now })
        .where(and(eq(SessionSubagentContinuationTable.id, id), eq(SessionSubagentContinuationTable.state, "admitted")))
        .returning({ id: SessionSubagentContinuationTable.id })
        .get()
        .pipe(Effect.orDie)
      return cancelled ? [cancelled.id] : []
    })

    const cancel: Interface["cancel"] = Effect.fn("SessionContinuation.cancel")(function* (id) {
      const snapshot = yield* load(id)
      if (!snapshot || terminal(snapshot.state)) return { waiterIDs: [], interrupt: false }
      if (snapshot.state === "bound") {
        // This call happens before SessionExecution publishes the user-interrupt
        // terminal, so it needs its own atomic turn-and-member transition.
        const ids = yield* db.transaction(() => cancelActive(snapshot.request.childSessionID)).pipe(Effect.orDie)
        yield* signal(ids)
        return { waiterIDs: ids.map(waiterID), interrupt: ids.length > 0 }
      }
      if (snapshot.state !== "admitted") return { waiterIDs: [], interrupt: false }
      let ids: ReadonlyArray<string> = []
      const cancelled = yield* SessionInbox.cancel(
        bus,
        {
          id: snapshot.request.inboxID,
          sessionID: snapshot.request.childSessionID,
        },
        {
          commit: () =>
            cancelPending(id).pipe(
              Effect.tap((updated) =>
                Effect.sync(() => {
                  ids = updated
                }),
              ),
            ),
        },
      ).pipe(
        Effect.as("cancelled" as const),
        Effect.catchDefect((defect) =>
          defect instanceof SessionInbox.LifecycleConflict ? Effect.succeed("retry" as const) : Effect.die(defect),
        ),
      )
      if (cancelled === "retry") return yield* cancel(id)
      yield* signal(ids)
      return { waiterIDs: ids.map(waiterID), interrupt: false }
    })

    const cancelChild: Interface["cancelChild"] = Effect.fn("SessionContinuation.cancelChild")(function* (sessionID) {
      const requestIDs = yield* db
        .transaction(() =>
          Effect.gen(function* () {
            const now = Date.now()
            yield* db
              .update(SessionSubagentTurnTable)
              .set({ state: "cancelled", time_terminal: now })
              .where(
                and(
                  eq(SessionSubagentTurnTable.child_session_id, sessionID),
                  eq(SessionSubagentTurnTable.state, "active"),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            const rows = yield* db
              .update(SessionSubagentContinuationTable)
              .set({ state: "cancelled", time_terminal: now })
              .where(
                and(
                  eq(SessionSubagentContinuationTable.child_session_id, sessionID),
                  inArray(SessionSubagentContinuationTable.state, ["admitted", "bound"]),
                ),
              )
              .returning({ id: SessionSubagentContinuationTable.id })
              .all()
              .pipe(Effect.orDie)
            return rows.map((row) => row.id).toSorted()
          }),
        )
        .pipe(Effect.orDie)
      yield* signal(requestIDs)
      return { requestIDs, waiterIDs: requestIDs.map(waiterID) }
    })

    const awaitResult: Interface["await"] = (id, options) =>
      Effect.gen(function* () {
        const inspect = Effect.fnUntraced(function* () {
          const snapshot = yield* load(id)
          if (!snapshot) return yield* Effect.die(new Error(`Continuation ${id} is missing`))
          if (snapshot.state === "completed") {
            const output = snapshot.turn?.output
            if (output === undefined) return yield* Effect.die(new Error(`Continuation ${id} completed without output`))
            return { state: "completed" as const, output }
          }
          if (snapshot.state === "failed") {
            const error = snapshot.turn?.error
            if (!error) return yield* Effect.die(new Error(`Continuation ${id} failed without error`))
            return { state: "failed" as const, error }
          }
          if (snapshot.state === "cancelled") return { state: "cancelled" as const }
          return { state: "pending" as const }
        })
        let delay = FOREIGN_RECONCILE_INITIAL_DELAY
        while (true) {
          const first = yield* inspect()
          if (first.state === "completed") return first.output
          if (first.state === "failed") return yield* new FailedError({ id, error: first.error })
          if (first.state === "cancelled") return yield* Effect.interrupt
          const gate = registerGate(id)
          const step = yield* Effect.gen(function* () {
            const second = yield* inspect()
            if (second.state === "completed") {
              yield* settleGate(id, gate)
              return { type: "completed" as const, output: second.output }
            }
            if (second.state === "failed") {
              yield* settleGate(id, gate)
              return { type: "failed" as const, error: second.error }
            }
            if (second.state === "cancelled") {
              yield* settleGate(id, gate)
              return { type: "cancelled" as const }
            }
            if (!options?.foreign) {
              yield* Deferred.await(gate.deferred)
              return { type: "retry" as const }
            }
            const wake = yield* Effect.raceFirst(
              Deferred.await(gate.deferred).pipe(Effect.as("signal" as const)),
              Effect.sleep(Duration.millis(delay)).pipe(Effect.as("reconcile" as const)),
            )
            if (wake === "signal") return { type: "retry" as const }
            const beforeWake = yield* inspect()
            if (beforeWake.state === "completed") {
              yield* settleGate(id, gate)
              return { type: "completed" as const, output: beforeWake.output }
            }
            if (beforeWake.state === "failed") {
              yield* settleGate(id, gate)
              return { type: "failed" as const, error: beforeWake.error }
            }
            if (beforeWake.state === "cancelled") {
              yield* settleGate(id, gate)
              return { type: "cancelled" as const }
            }
            yield* options.foreign.wake
            return { type: "reconciled" as const }
          }).pipe(Effect.ensuring(releaseGate(id, gate)))
          if (step.type === "completed") return step.output
          if (step.type === "failed") return yield* new FailedError({ id, error: step.error })
          if (step.type === "cancelled") return yield* Effect.interrupt
          if (step.type === "reconciled") delay = Math.min(FOREIGN_RECONCILE_MAX_DELAY, delay * 2)
        }
      }).pipe(Effect.withSpan("SessionContinuation.await"))

    const assertSettled: Interface["assertSettled"] = Effect.fn("SessionContinuation.assertSettled")(
      function* (sessionID) {
        const turn = yield* active(sessionID)
        if (turn)
          return yield* Effect.die(new Error(`Session ${sessionID} completed with active continuation turn ${turn.id}`))
      },
    )

    return {
      admit,
      bind,
      get: load,
      matches,
      active,
      complete,
      failActive,
      cancelActive,
      cancel,
      cancelChild,
      await: awaitResult,
      signal,
      assertSettled,
    } satisfies Interface
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    return Service.of(yield* make(db, bus))
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })
