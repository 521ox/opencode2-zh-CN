export * as SessionExecution from "./execution.js"

import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { Cause, Context, Duration, Effect, Exit, Layer, Schedule } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Job } from "../job.js"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { SessionEvent } from "./event.js"
import { SessionRunCoordinator } from "./run-coordinator.js"
import { SessionRunner } from "./runner/index.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { toSessionError } from "./to-session-error.js"
import { UserInterruptedError } from "./error.js"
import { SessionInbox } from "./inbox.js"
import { SessionContinuation } from "./continuation.js"

export type WakeResult = { readonly type: "owned" } | { readonly type: "foreign" }

export interface Interface {
  /** Stable owner identity shared by every Session lease in this process. */
  readonly owner?: SessionStore.Owner
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Atomically acquires or renews this process's Session lease. */
  readonly claim?: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Starts execution after the caller already acquired this process's Session lease. */
  readonly resumeClaimed?: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work and reports whether this process owns the execution lease. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<WakeResult>
  /**
   * Interrupt active work owned by this process. Idle interruption is a no-op. Resolves once
   * the interruption is accepted; cleanup settles asynchronously in the execution fiber.
   * Returns whether an active execution was interrupted. Compose with `awaitIdle` when
   * settlement matters.
   */
  readonly interrupt: (sessionID: SessionSchema.ID, options?: { readonly continue?: boolean }) => Effect.Effect<boolean>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to the runner owned by that Session's selected Instance. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecution") {}

type InterruptReason = "user" | "shutdown"
const LEASE_MS = 30_000

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason) {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  const failure = Cause.squash(exit.cause)
  if (failure instanceof UserInterruptedError) return { type: "interrupted" as const, reason: "user" as const }
  return { type: "failed" as const, error: toSessionError(failure) }
}

/** Process-local execution: drains run in this process, routed through the Session's selected Instance. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const owner: SessionStore.Owner = {
      id: `${process.pid}-${randomUUID()}`,
      pid: process.pid,
      hostname: hostname(),
      leaseMs: LEASE_MS,
    }
    const instances = yield* Instance.Service
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    const continuations = yield* SessionContinuation.Service
    const db = (yield* Database.Service).db
    const reportLifecycle = <A>(sessionID: SessionSchema.ID, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs({ sessionID }),
              ),
        ),
        Effect.asVoid,
      )
    const releaseOnCommit = (sessionID: SessionSchema.ID, transition: Effect.Effect<void> = Effect.void) => ({
      commit: () =>
        transition.pipe(
          Effect.andThen(store.release(sessionID, owner)),
          Effect.flatMap(SessionStore.requireOwnership(sessionID, owner, "terminal commit")),
        ),
    })
    const ownsOnCommit = (sessionID: SessionSchema.ID, operation: string) => ({
      commit: () =>
        store.owns(sessionID, owner).pipe(Effect.flatMap(SessionStore.requireOwnership(sessionID, owner, operation))),
    })
    const drain = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      force: boolean,
      continuation?: SessionRunner.Continuation,
      promotable: SessionInbox.Promotable = "input",
    ): Effect.fn.Return<void, SessionRunner.RunError> {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      const result = yield* SessionRunner.Service.use((runner) =>
        runner.drain({ sessionID, force, continuation, promotable }),
      ).pipe(
        instances.provide(session),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )
      return yield* SessionRunner.DrainResult.$match(result, {
        Complete: () => Effect.void,
        Moved: (result) => drain(sessionID, false, result.continuation, promotable),
      })
    })
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError, InterruptReason>({
      started: (sessionID) => reportLifecycle(sessionID, bus.publish(SessionEvent.Execution.Started, { sessionID })),
      drain: (sessionID, force, promotable) => drain(sessionID, force, undefined, promotable),
      // One terminal observation per busy period, covering every coalesced drain.
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            const outcome = terminal(exit, reason)
            const owned =
              outcome.type === "interrupted" && outcome.reason === "shutdown"
                ? yield* store.owns(sessionID, owner)
                : yield* store.touch(sessionID, owner)
            if (!owned) return
            if (outcome.type === "succeeded") {
              yield* bus.publish(
                SessionEvent.Execution.Succeeded,
                { sessionID },
                releaseOnCommit(sessionID, continuations.assertSettled(sessionID)),
              )
              return
            }
            if (outcome.type === "interrupted") {
              // A user cancel releases the lease: the turn must not resurrect at the next boot.
              if (outcome.reason === "user") yield* jobs.cancel(sessionID)
              let cancelled: ReadonlyArray<string> = []
              yield* bus.publish(
                SessionEvent.Execution.Interrupted,
                { sessionID, reason: outcome.reason },
                outcome.reason === "shutdown"
                  ? ownsOnCommit(sessionID, "shutdown terminal commit")
                  : releaseOnCommit(
                      sessionID,
                      continuations.cancelActive(sessionID).pipe(
                        Effect.tap((ids) =>
                          Effect.sync(() => {
                            cancelled = ids
                          }),
                        ),
                        Effect.asVoid,
                      ),
                    ),
              )
              if (outcome.reason === "user") {
                yield* continuations.signal(cancelled)
                yield* Effect.forEach(cancelled, (id) => jobs.cancel(SessionContinuation.waiterID(id)), {
                  discard: true,
                })
              }
              return
            }
            let failed: ReadonlyArray<string> = []
            yield* bus.publish(
              SessionEvent.Execution.Failed,
              {
                sessionID,
                error: outcome.error,
              },
              releaseOnCommit(
                sessionID,
                continuations.failActive({ sessionID, error: outcome.error }).pipe(
                  Effect.tap((ids) =>
                    Effect.sync(() => {
                      failed = ids
                    }),
                  ),
                  Effect.asVoid,
                ),
              ),
            )
            yield* continuations.signal(failed)
          }),
        ),
    })

    const claim = (sessionID: SessionSchema.ID) => store.claim(sessionID, owner)
    const resumeClaimed = (sessionID: SessionSchema.ID) =>
      store.touch(sessionID, owner).pipe(Effect.flatMap((owned) => (owned ? coordinator.run(sessionID) : Effect.void)))
    const resume = Effect.fn("SessionExecution.resume")(function* (sessionID: SessionSchema.ID) {
      if (!(yield* claim(sessionID))) return
      yield* coordinator.run(sessionID)
    })
    const wake = Effect.fn("SessionExecution.wake")(function* (sessionID: SessionSchema.ID) {
      if (!(yield* claim(sessionID))) return { type: "foreign" as const }
      yield* coordinator.wake(sessionID)
      return { type: "owned" as const }
    })
    const renew = Effect.gen(function* () {
      const active = yield* coordinator.active
      yield* Effect.forEach(
        active,
        (sessionID) =>
          store
            .touch(sessionID, owner)
            .pipe(Effect.flatMap((owned) => (owned ? Effect.void : coordinator.interrupt(sessionID, "shutdown")))),
        { discard: true },
      )
    })
    yield* renew.pipe(Effect.repeat(Schedule.spaced(Duration.millis(LEASE_MS / 3))), Effect.forkScoped)
    yield* Effect.addFinalizer(() => store.expireOwner(owner))

    return Service.of({
      owner,
      active: coordinator.active,
      interrupt: (sessionID, options) =>
        Effect.gen(function* () {
          const interrupted = yield* coordinator.interrupt(sessionID, "user")
          if (!options?.continue) return interrupted
          // Resume steering input and between-turn control work from the interrupted
          // intent. Queued next-turn prompts stay parked: a steer-scoped drain never
          // promotes them, and a control item behind a queued prompt waits its turn.
          // Interruption acknowledges before cleanup settles, so this wake usually lands
          // on the stopping execution's doorbell and starts the successor at settle.
          // Reading the inbox concurrently with the dying drain is safe: delivery consumes
          // rows inside uninterruptible publications, so a steer row is either still
          // promotable here or was fully delivered and needs no resumption.
          const next = yield* SessionInbox.nextPromotable(db, sessionID, "input")
          if (next === undefined) return interrupted
          if (next.delivery === "steer" || next.type === "compaction" || next.type === "move") {
            if (!(yield* claim(sessionID))) return interrupted
            yield* coordinator.wake(sessionID, "steer")
          }
          return interrupted
        }),
      claim,
      resume,
      resumeClaimed,
      wake,
      awaitIdle: coordinator.awaitIdle,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, Instance.node, Bus.node, Database.node, Job.node, SessionContinuation.node],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    owner: { id: "noop", pid: 0, hostname: "noop", leaseMs: LEASE_MS },
    active: Effect.succeed(new Set()),
    claim: () => Effect.succeed(true),
    resume: () => Effect.void,
    resumeClaimed: () => Effect.void,
    wake: () => Effect.succeed({ type: "owned" as const }),
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
