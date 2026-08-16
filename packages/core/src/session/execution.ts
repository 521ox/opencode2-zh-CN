export * as SessionExecution from "./execution.js"

import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { Cause, Context, Duration, Effect, Exit, Layer, Schedule } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { LocationServiceMap } from "../location-service-map.js"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { SessionEvent } from "./event.js"
import { SessionRunCoordinator } from "./run-coordinator.js"
import { SessionRunner } from "./runner/index.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { toSessionError } from "./to-session-error.js"
import { UserInterruptedError } from "./error.js"
import { SessionInbox } from "./inbox.js"

export interface Interface {
  /** Stable owner identity shared by every claim in this process. */
  readonly owner: SessionStore.Owner
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Atomically acquires or renews this process's Session lease. */
  readonly claim: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Starts execution after the caller has already acquired this process's lease. */
  readonly resumeClaimed: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Wakes only an active execution, preserving its current input eligibility. */
  readonly wakeActive: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID, options?: { readonly continue?: boolean }) => Effect.Effect<void>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecution") {}

type InterruptReason = "user" | "shutdown" | "superseded"
const LEASE_MS = 30_000

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason) {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  const failure = Cause.squash(exit.cause)
  if (failure instanceof UserInterruptedError) return { type: "interrupted" as const, reason: "user" as const }
  return { type: "failed" as const, error: toSessionError(failure) }
}

/** Process-local execution: drains run in this process, routed through the Session's Location graph. */
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
    const locations = yield* LocationServiceMap.Service
    const bus = yield* Bus.Service
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
    const releaseOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () =>
        store
          .release(sessionID, owner)
          .pipe(Effect.flatMap(SessionStore.requireOwnership(sessionID, owner, "terminal commit"))),
    })
    function drain(
      sessionID: SessionSchema.ID,
      force: boolean,
      continuation?: SessionRunner.Continuation,
      promotable: SessionInbox.Promotable = "input",
    ): Effect.Effect<void, SessionRunner.RunError> {
      return Effect.gen(function* () {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
        const result = yield* SessionRunner.Service.use((runner) =>
          runner.drain({ sessionID, force, continuation, promotable }),
        ).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
        if (result.type === "complete") return
        return yield* drain(sessionID, false, result.continuation, promotable)
      })
    }
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError, InterruptReason>({
      started: (sessionID) => reportLifecycle(sessionID, bus.publish(SessionEvent.Execution.Started, { sessionID })),
      drain: (sessionID, force, promotable) => drain(sessionID, force, undefined, promotable),
      // One terminal observation per busy period, covering every coalesced drain.
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            const outcome = terminal(exit, reason)
            if (outcome.type === "interrupted" && outcome.reason === "shutdown") return
            if (!(yield* store.touch(sessionID, owner))) return
            if (outcome.type === "succeeded") {
              yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, releaseOnCommit(sessionID))
              return
            }
            if (outcome.type === "interrupted") {
              // A user cancel (or a superseding execution) releases the claim: the turn must not
              // resurrect at the next boot. Shutdown interruption keeps it for restart continuity.
              yield* bus.publish(
                SessionEvent.Execution.Interrupted,
                { sessionID, reason: outcome.reason },
                releaseOnCommit(sessionID),
              )
              return
            }
            yield* bus.publish(
              SessionEvent.Execution.Failed,
              {
                sessionID,
                error: outcome.error,
              },
              releaseOnCommit(sessionID),
            )
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
      if (!(yield* claim(sessionID))) return
      yield* coordinator.wake(sessionID)
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
      claim,
      interrupt: (sessionID, options) =>
        coordinator.interrupt(
          sessionID,
          "user",
          options?.continue
            ? { continue: { request: "steer", when: SessionInbox.has(db, sessionID, "steer") } }
            : undefined,
        ),
      resume,
      resumeClaimed,
      wake,
      wakeActive: coordinator.wakeActive,
      awaitIdle: coordinator.awaitIdle,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, Bus.node, Database.node],
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
    wake: () => Effect.void,
    wakeActive: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
  }),
)
