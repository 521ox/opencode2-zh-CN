export * as SessionRestart from "./restart.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Bus } from "../../bus.js"
import { Job } from "../../job.js"
import { Session } from "../../session.js"
import { SessionEvent } from "../event.js"
import { SessionExecution } from "../execution.js"
import { SubagentCompletion } from "../subagent-completion.js"
import { SessionContinuation } from "../continuation.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"

const CONTINUE_AFTER_SERVER_RESTART =
  "The server restarted while you were working. Continue from where you left off without repeating completed work."

const RESUME_EXHAUSTED = {
  type: "aborted",
  message: "Execution was interrupted repeatedly and will not be resumed automatically.",
} as const
export interface Options {
  /**
   * Times a single turn may be resumed before it is terminalized instead.
   * The counter is durable and only a terminal event resets it, so a turn
   * that keeps dying cannot crash-loop across restarts. Turns that complete
   * never accumulate: the budget is per-turn, not per-session.
   */
  readonly maxAttempts?: number
}

const DEFAULT_MAX_ATTEMPTS = 10

export interface Interface {
  /**
   * Resumes Sessions whose execution claim was never released — turns orphaned
   * by a process that died without teardown, or interrupted by a graceful
   * shutdown (which preserves the claim on purpose). The claim is never
   * cleared here: only a terminal event releases it, so a death anywhere in
   * the resume path leaves the same orphaned claim for the next boot.
   */
  readonly resumeSuspendedSessions: Effect.Effect<void>
}

/**
 * Recovery for orphaned executions. Claims are written at turn start by
 * SessionExecution, so this sweep needs no cooperation from the previous
 * process: crash, SIGKILL, isolate eviction, and graceful restart all leave
 * the same durable signature.
 *
 * Recovery is at-least-once: local coordination prevents concurrent drains,
 * not repeated external side effects after a crash.
 *
 * The sweep assumes every orphaned claim's owner is dead. The managed-server
 * protocol guarantees this: a successor is only spawned after the previous
 * process is confirmed dead (client service `kill`/`evict` poll the PID), the
 * registration lock admits one managed server at a time, and unregistered
 * servers sharing the database never sweep. The service is inert until called
 * — the managed server invokes it at boot; embedders may call it from their
 * own start-up.
 */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRestart") {}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      const execution = yield* SessionExecution.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const sessions = yield* Session.Service
      const continuations = yield* SessionContinuation.Service
      const scope = yield* Effect.scope
      const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
      const owner = execution.owner
      const claim = execution.claim
      const resumeClaimed = execution.resumeClaimed
      if (!owner || !claim || !resumeClaimed)
        return yield* Effect.die(new Error("Session restart requires the production Session execution lease controls"))

      const prepareResume = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
        if (!(yield* claim(sessionID))) return "foreign" as const
        // Durable before the resume runs, so a crash inside the resumed turn is
        // counted by the next sweep and the budget cannot be dodged.
        const attempts = yield* store.countResume(sessionID, owner)
        if (attempts === undefined) return "unavailable" as const
        if (attempts > maxAttempts) {
          // Terminalize instead: the release hook clears the claim and resets the
          // counter atomically with the terminal event.
          let failed: ReadonlyArray<string> = []
          yield* bus.publish(
            SessionEvent.Execution.Failed,
            { sessionID, error: RESUME_EXHAUSTED },
            {
              commit: () =>
                continuations.failActive({ sessionID, error: RESUME_EXHAUSTED }).pipe(
                  Effect.tap((ids) =>
                    Effect.sync(() => {
                      failed = ids
                    }),
                  ),
                  Effect.asVoid,
                  Effect.andThen(store.release(sessionID, owner)),
                  Effect.flatMap(SessionStore.requireOwnership(sessionID, owner, "resume exhaustion terminal commit")),
                ),
            },
          )
          yield* continuations.signal(failed)
          return "exhausted" as const
        }
        yield* bus.publish(
          SessionEvent.Synthetic,
          {
            sessionID,
            text: CONTINUE_AFTER_SERVER_RESTART,
            description: "Continuing after restart",
          },
          {
            commit: () =>
              store
                .touch(sessionID, owner)
                .pipe(Effect.flatMap(SessionStore.requireOwnership(sessionID, owner, "restart continuation commit"))),
          },
        )
        return "ready" as const
      })

      const recoverShell = Effect.fnUntraced(function* (
        background: Job.Background,
        recovery: Extract<Job.Recovery, { kind: "shell" }>,
        suspended: ReadonlySet<SessionSchema.ID>,
      ) {
        if (!(yield* store.get(recovery.sessionID))) {
          yield* jobs.completeBackground(background.notificationID)
          return
        }
        if (!(yield* claim(recovery.sessionID))) return
        const state = background.status === "running" ? "cancelled" : background.status
        const text =
          background.status === "running"
            ? "Command cancelled because the server restarted"
            : state === "completed"
              ? (background.output ?? "Command completed")
              : state === "error"
                ? (background.error ?? "Command failed")
                : "Command cancelled"

        yield* sessions
          .synthetic({
            id: background.notificationID,
            sessionID: recovery.sessionID,
            description: recovery.command,
            text: `<shell id="${background.id}" state="${state}" command="${recovery.command}">\n${text}\n</shell>`,
            metadata: {
              source: "shell",
              jobID: background.id,
              shellID: recovery.shellID,
              state,
            },
            ...(suspended.has(recovery.sessionID) ? { resume: false } : {}),
          })
          .pipe(
            Effect.catchTag("Session.NotFoundError", () => Effect.void),
            Effect.orDie,
          )
        yield* jobs.completeBackground(background.notificationID)
      })

      const recoverContinuationSubagent = Effect.fnUntraced(function* (
        background: Job.Background,
        recovery: Extract<Job.Recovery, { kind: "subagent" }> & { readonly continuationID: string },
        suspended: ReadonlySet<SessionSchema.ID>,
      ) {
        const child = yield* store.get(recovery.childSessionID)
        if (!child || child.parentID !== recovery.parentSessionID || !(yield* store.get(recovery.parentSessionID))) {
          yield* jobs.completeBackground(background.notificationID)
          return
        }

        const notify = Effect.fnUntraced(function* (result: Pick<Job.Background, "status" | "output" | "error">) {
          if (result.status === "running") return
          if (!(yield* claim(recovery.parentSessionID))) return
          yield* SubagentCompletion.deliver(sessions, jobs, {
            ...result,
            notificationID: background.notificationID,
            recovery,
            ...(suspended.has(recovery.parentSessionID) ? { resume: false } : {}),
          }).pipe(Effect.orDie)
        })

        const continuation = yield* continuations.get(recovery.continuationID)
        if (
          !continuation ||
          continuation.request.parentSessionID !== recovery.parentSessionID ||
          continuation.request.childSessionID !== recovery.childSessionID
        ) {
          yield* notify({ status: "error", error: "Subagent continuation is unavailable after restart" })
          return
        }
        if (continuation.state === "completed") {
          yield* notify({ status: "completed", output: continuation.turn?.output })
          return
        }
        if (continuation.state === "failed") {
          yield* notify({ status: "error", error: continuation.turn?.error?.message })
          return
        }
        if (continuation.state === "cancelled") {
          yield* notify({ status: "cancelled" })
          return
        }

        let resume = false
        let foreign = false
        if (!(yield* execution.active).has(recovery.childSessionID)) {
          const prepared = yield* prepareResume(recovery.childSessionID)
          if (prepared === "unavailable") return
          foreign = prepared === "foreign"
          resume = prepared === "ready"
        }
        let recoveryStarted = resume
        const reconcile = Effect.gen(function* () {
          if (recoveryStarted) return
          const prepared = yield* prepareResume(recovery.childSessionID)
          if (prepared !== "ready") return
          // Count and publish the G3 restart transition at most once after the foreign lease releases.
          recoveryStarted = true
          yield* resumeClaimed(recovery.childSessionID).pipe(Effect.ignore, Effect.forkIn(scope))
        })
        const wait = continuations
          .await(
            recovery.continuationID,
            foreign
              ? {
                  foreign: { wake: reconcile },
                }
              : undefined,
          )
          .pipe(
            Effect.catchTag("SessionContinuation.FailedError", (error) => Effect.fail(new Error(error.error.message))),
          )
        const info = yield* jobs.start({
          id: background.id,
          type: "subagent",
          title: recovery.description,
          notificationID: background.notificationID,
          recovery,
          run: resume
            ? Effect.gen(function* () {
                yield* resumeClaimed(recovery.childSessionID).pipe(Effect.forkIn(scope))
                return yield* wait
              })
            : wait,
        })
        yield* jobs.background(info.id)
        yield* jobs.wait({ id: info.id }).pipe(
          Effect.flatMap((result) => (result.info ? notify(result.info) : Effect.void)),
          Effect.ignore,
          Effect.forkIn(scope),
        )
      })

      const recoverSubagent = Effect.fnUntraced(function* (
        background: Job.Background,
        recovery: Extract<Job.Recovery, { kind: "subagent" }>,
        suspended: ReadonlySet<SessionSchema.ID>,
      ) {
        if (recovery.continuationID !== undefined)
          return yield* recoverContinuationSubagent(
            background,
            { ...recovery, continuationID: recovery.continuationID },
            suspended,
          )
        const child = yield* store.get(recovery.childSessionID)
        if (!child || child.parentID !== recovery.parentSessionID || !(yield* store.get(recovery.parentSessionID))) {
          yield* jobs.completeBackground(background.notificationID)
          return
        }

        const notify = Effect.fnUntraced(function* (result: Pick<Job.Background, "status" | "output" | "error">) {
          if (result.status === "running") return
          if (!(yield* claim(recovery.parentSessionID))) return
          yield* SubagentCompletion.deliver(sessions, jobs, {
            ...result,
            notificationID: background.notificationID,
            recovery,
            ...(suspended.has(recovery.parentSessionID) ? { resume: false } : {}),
          }).pipe(Effect.orDie)
        })

        if (background.status !== "running") {
          yield* notify(background)
          return
        }
        if ((yield* execution.active).has(recovery.childSessionID)) return
        const prepared = yield* prepareResume(recovery.childSessionID)
        if (prepared === "unavailable" || prepared === "foreign") return
        if (prepared === "exhausted") {
          yield* notify({ status: "error", error: RESUME_EXHAUSTED.message })
          return
        }

        yield* jobs.start({
          id: background.id,
          type: "subagent",
          title: recovery.description,
          notificationID: background.notificationID,
          recovery,
          run: resumeClaimed(recovery.childSessionID).pipe(
            Effect.andThen(store.context(recovery.childSessionID)),
            Effect.map((messages) => {
              const assistant = messages.findLast(
                (message) =>
                  message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
              )
              return SubagentCompletion.text(assistant)
            }),
          ),
        })
        yield* jobs.background(background.id)
        yield* jobs.wait({ id: background.id }).pipe(
          Effect.flatMap((result) => (result.info ? notify(result.info) : Effect.void)),
          Effect.ignore,
          Effect.forkIn(scope),
        )
      })

      return Service.of({
        resumeSuspendedSessions: Effect.gen(function* () {
          const active = yield* execution.active
          const topLevel = (yield* store.listSuspended()).filter((sessionID) => !active.has(sessionID))
          const pending = yield* jobs.pendingBackground
          const children = pending.flatMap((background) =>
            background.status === "running" && background.recovery.kind === "subagent"
              ? [background.recovery.childSessionID]
              : [],
          )
          // Early notices wait for recovery's accounting, including Sessions that exhaust their budget.
          const suspended = new Set([...topLevel, ...children])
          yield* store.releaseChildClaims(children, owner)
          yield* Effect.forEach(
            // Admit shell outcomes before a recovered child can start its first model request.
            pending.toSorted((a, b) => Number(a.recovery.kind === "subagent") - Number(b.recovery.kind === "subagent")),
            Effect.fnUntraced(function* (background) {
              if ((yield* jobs.get(background.id))?.status === "running") return
              const recovery = background.recovery
              yield* recovery.kind === "shell"
                ? recoverShell(background, recovery, suspended)
                : recoverSubagent(background, recovery, suspended)
            }),
            { discard: true },
          )

          // Background completion can wake a parent, so retain only initially suspended
          // top-level Sessions for restart accounting.
          const resumed = yield* execution.active
          yield* Effect.forEach(
            topLevel.filter((sessionID) => !resumed.has(sessionID)),
            Effect.fnUntraced(function* (sessionID) {
              if ((yield* prepareResume(sessionID)) !== "ready") return
              yield* resumeClaimed(sessionID).pipe(Effect.ignore, Effect.forkIn(scope))
            }),
            { concurrency: "unbounded", discard: true },
          )
          // Async observers consult this set at delivery; later completions wake parents normally.
          suspended.clear()
        }),
      })
    }),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [SessionStore.node, SessionExecution.node, SessionContinuation.node, Bus.node, Job.node, Session.node],
})
