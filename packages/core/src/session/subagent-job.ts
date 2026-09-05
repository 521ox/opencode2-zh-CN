export * as SubagentJob from "./subagent-job.js"

import { Deferred, Effect, Scope } from "effect"
import { Job } from "../job.js"
import type { PluginRuntime } from "../plugin/runtime.js"
import { Session } from "../session.js"
import { SessionContinuation } from "./continuation.js"
import { SubagentCompletion } from "./subagent-completion.js"

export const make = (runtime: PluginRuntime.Interface) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const notifications = new Set<string>()

    const notify = Effect.fn("SubagentJob.notify")(function* (
      recovery: Extract<Job.Recovery, { kind: "subagent" }>,
      waiterID: string,
      startedAt: number,
    ) {
      const key = `${waiterID}:${startedAt}`
      if (notifications.has(key)) return
      notifications.add(key)
      yield* Effect.gen(function* () {
        const info = (yield* runtime.job.wait({ id: waiterID })).info
        if (info) yield* SubagentCompletion.deliver(runtime.session, runtime.job, { ...info, recovery })
      }).pipe(
        Effect.ensuring(Effect.sync(() => notifications.delete(key))),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    const background = Effect.fn("SubagentJob.background")(function* (request: SessionContinuation.Request) {
      const recovery: Extract<Job.Recovery, { kind: "subagent" }> = {
        kind: "subagent",
        parentSessionID: request.parentSessionID,
        childSessionID: request.childSessionID,
        agent: request.agent,
        description: request.description,
        continuationID: request.id,
      }
      const wake = yield* Deferred.make<Session.WakeResult, Session.NotFoundError>()
      const run: Effect.Effect<string, unknown> = Deferred.await(wake).pipe(
        Effect.flatMap((result) =>
          runtime.continuation.await(
            request.id,
            result.type === "foreign"
              ? {
                  foreign: {
                    wake: runtime.session.wake(request.childSessionID).pipe(Effect.asVoid),
                  },
                }
              : undefined,
            ),
        ),
        Effect.catchTag("SessionContinuation.FailedError", (error) => Effect.fail(new Error(error.error.message))),
      )
      const started = yield* runtime.job.guardedStart({
        id: request.waiterID,
        type: "subagent",
        title: request.description,
        metadata: {},
        recovery,
        run,
        guard: runtime.continuation
          .get(request.id)
          .pipe(Effect.map((continuation) => continuation?.state === "admitted" || continuation?.state === "bound")),
      })

      if (started.type === "existing-terminal" || started.type === "skipped-terminal") {
        const terminal = yield* runtime.continuation.get(request.id)
        if (terminal?.state === "completed") {
          yield* SubagentCompletion.deliver(runtime.session, runtime.job, {
            status: "completed",
            output: terminal.turn?.output,
            recovery,
          })
          return
        }
        if (terminal?.state === "failed") {
          yield* SubagentCompletion.deliver(runtime.session, runtime.job, {
            status: "error",
            error: terminal.turn?.error?.message,
            recovery,
          })
          return
        }
        if (terminal?.state === "cancelled") {
          yield* SubagentCompletion.deliver(runtime.session, runtime.job, { status: "cancelled", recovery })
          return
        }
        return yield* Effect.fail(new Error(`Subagent continuation ${request.id} is unavailable`))
      }

      const info = yield* runtime.job.background(started.info.id)
      if (!info) return yield* Effect.fail(new Error(`Subagent job ${started.info.id} is unavailable`))
      yield* notify(recovery, info.id, info.started_at)
      yield* runtime.session.wake(request.childSessionID).pipe(
        Effect.tap((result) => Deferred.succeed(wake, result).pipe(Effect.asVoid)),
        Effect.catch((error) => Deferred.fail(wake, error).pipe(Effect.andThen(Effect.fail(error)))),
      )
    })

    return { background }
  })
