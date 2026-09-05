import { describe, expect } from "bun:test"
import { Job } from "@opencode-ai/core/job"
import { KV } from "@opencode-ai/core/kv"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Job.node, KV.node])))

const waitForTerminal = (jobs: Job.Interface, id: string) =>
  Effect.gen(function* () {
    while (true) {
      const info = yield* jobs.get(id)
      if (info === undefined) return yield* Effect.die(`Job unexpectedly missing: ${id}`)
      if (info.status !== "running") return info
      yield* Effect.yieldNow
    }
  })

describe("Job", () => {
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }),
  )

  it.live("reuses running work when started again with the same ID", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const output = yield* Deferred.make<string>()
      const job = yield* jobs.start({ id: "job_reused", type: "test", run: Deferred.await(output) })

      expect(
        yield* jobs.start({ id: job.id, type: "duplicate", run: Effect.die("Duplicate work must not run") }),
      ).toEqual(job)

      yield* Deferred.succeed(output, "original output")
      expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({
        type: "test",
        status: "completed",
        output: "original output",
      })
    }),
  )

  it.live("ignores an obsolete callback after a cancellation waiter starts a same-ID replacement", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const callback = yield* Deferred.make<() => void>()
      const output = yield* Deferred.make<string>()
      const finalized = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        id: "job_replaced",
        type: "test",
        run: Effect.callback<string>((resume) => {
          Deferred.doneUnsafe(callback, Effect.succeed(() => resume(Effect.succeed("obsolete output"))))
        }),
      })
      const complete = yield* Deferred.await(callback)
      const replacement = yield* jobs.wait({ id: job.id }).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.info?.status).toBe("cancelled"))),
        Effect.andThen(
          jobs.start({
            id: job.id,
            type: "replacement",
            run: Deferred.await(output).pipe(Effect.ensuring(Deferred.succeed(finalized, undefined))),
          }),
        ),
        Effect.andThen(Effect.sync(complete)),
        Effect.forkChild({ startImmediately: true }),
      )

      yield* jobs.cancel(job.id)
      yield* Fiber.join(replacement)
      expect(yield* jobs.get(job.id)).toMatchObject({ type: "replacement", status: "running" })
      expect(yield* Deferred.isDone(finalized)).toBe(false)

      yield* Deferred.succeed(output, "replacement output")
      expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({
        type: "replacement",
        status: "completed",
        output: "replacement output",
      })
      expect(yield* Deferred.isDone(finalized)).toBe(true)
    }),
  )

  it.live("guards terminal-or-start atomically while preserving generic start behavior", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const runningLatch = yield* Deferred.make<void>()
      let guardCalls = 0
      const first = yield* jobs.guardedStart({
        id: "job_guarded_running",
        type: "test",
        guard: Effect.sync(() => {
          guardCalls++
          return true
        }),
        run: Deferred.await(runningLatch).pipe(Effect.as("first complete")),
      })
      expect(first).toMatchObject({ type: "started", info: { id: "job_guarded_running", status: "running" } })
      expect(guardCalls).toBe(1)

      const reused = yield* jobs.guardedStart({
        id: "job_guarded_running",
        type: "test",
        guard: Effect.die("running generation must not invoke the guard"),
        run: Effect.die("running generation must not start another run"),
      })
      expect(reused).toMatchObject({ type: "running", info: { id: "job_guarded_running", status: "running" } })
      expect(guardCalls).toBe(1)
      yield* Deferred.succeed(runningLatch, undefined)
      expect(yield* waitForTerminal(jobs, "job_guarded_running")).toMatchObject({ status: "completed" })

      const existingTerminal = yield* jobs.guardedStart({
        id: "job_guarded_running",
        type: "test",
        guard: Effect.succeed(false),
        run: Effect.die("terminal guard false must not replace the generation"),
      })
      expect(existingTerminal).toMatchObject({
        type: "existing-terminal",
        info: { id: "job_guarded_running", status: "completed", output: "first complete" },
      })
      expect(yield* jobs.get("job_guarded_running")).toMatchObject({ status: "completed", output: "first complete" })

      const missingTerminal = yield* jobs.guardedStart({
        id: "job_guarded_missing",
        type: "test",
        guard: Effect.succeed(false),
        run: Effect.die("missing terminal guard false must not start a generation"),
      })
      expect(missingTerminal).toEqual({ type: "skipped-terminal" })
      expect(yield* jobs.get("job_guarded_missing")).toBeUndefined()

      const failed = yield* jobs.start({
        id: "job_guarded_failed",
        type: "test",
        run: Effect.fail(new Error("first failed")),
      })
      expect(yield* waitForTerminal(jobs, failed.id)).toMatchObject({ status: "error", error: "first failed" })
      let continuationNonterminal = false
      const retainedFailure = yield* jobs.guardedStart({
        id: failed.id,
        type: "test",
        guard: Effect.sync(() => continuationNonterminal),
        run: Effect.die("terminal R must not replace a failed generation"),
      })
      expect(retainedFailure).toMatchObject({ type: "existing-terminal", info: { status: "error" } })

      continuationNonterminal = true
      const replacement = yield* jobs.guardedStart({
        id: failed.id,
        type: "test",
        guard: Effect.sync(() => continuationNonterminal),
        run: Effect.succeed("replacement complete"),
      })
      expect(replacement).toMatchObject({ type: "started", info: { id: failed.id, status: "running" } })
      expect(yield* waitForTerminal(jobs, failed.id)).toMatchObject({
        status: "completed",
        output: "replacement complete",
      })
    }),
  )

  it.live("returns finished from a blocking wait when completion wins", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", run: Deferred.await(latch).pipe(Effect.as("done")) })
      const waiting = yield* jobs
        .block({ id: job.id, sessionID: SessionSchema.ID.make("ses_parent") })
        .pipe(Effect.forkIn(yield* Scope.Scope, { startImmediately: true }))

      yield* Deferred.succeed(latch, undefined)

      expect(yield* Fiber.join(waiting)).toMatchObject({
        type: "finished",
        info: { status: "completed", output: "done" },
      })
      expect(yield* jobs.background(job.id)).toBeUndefined()
    }),
  )

  it.live("returns backgrounded from a blocking wait when background wins", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", run: Deferred.await(latch).pipe(Effect.as("done")) })
      const waiting = yield* jobs
        .block({ id: job.id, sessionID: SessionSchema.ID.make("ses_parent") })
        .pipe(Effect.forkIn(yield* Scope.Scope, { startImmediately: true }))

      expect(yield* jobs.background(job.id)).toMatchObject({ id: job.id, status: "running" })
      expect(yield* Fiber.join(waiting)).toMatchObject({
        type: "backgrounded",
        info: { id: job.id, status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }),
  )

  it.live("backgrounds only jobs actively blocking a session", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const parent = SessionSchema.ID.make("ses_parent")
      const other = SessionSchema.ID.make("ses_other")
      const latch = yield* Deferred.make<void>()
      const first = yield* jobs.start({
        id: "job_first",
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as("first")),
      })
      const second = yield* jobs.start({
        id: "job_second",
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as("second")),
      })
      const third = yield* jobs.start({
        id: "job_third",
        type: "other",
        run: Deferred.await(latch).pipe(Effect.as("third")),
      })
      const scope = yield* Scope.Scope
      const firstWait = yield* jobs
        .block({ id: first.id, sessionID: parent })
        .pipe(Effect.forkIn(scope, { startImmediately: true }))
      const secondWait = yield* jobs
        .block({ id: second.id, sessionID: other })
        .pipe(Effect.forkIn(scope, { startImmediately: true }))
      const thirdWait = yield* jobs
        .block({ id: third.id, sessionID: parent })
        .pipe(Effect.forkIn(scope, { startImmediately: true }))

      expect(yield* jobs.backgroundAll({ sessionID: parent, type: "test" })).toMatchObject([{ id: first.id }])
      expect(yield* Fiber.join(firstWait)).toMatchObject({ type: "backgrounded", info: { id: first.id } })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* Fiber.join(secondWait)).toMatchObject({ type: "finished", info: { id: second.id } })
      expect(yield* Fiber.join(thirdWait)).toMatchObject({ type: "finished", info: { id: third.id } })
    }),
  )

  it.effect("retains 128 terminal snapshots in settlement order at one clock value without evicting running work", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const runningLatch = yield* Deferred.make<void>()
      const running = yield* jobs.start({
        id: "job_retention_running",
        type: "test",
        run: Deferred.await(runningLatch).pipe(Effect.as("running done")),
      })
      const terminals = yield* Effect.forEach(Array.from({ length: Job.TERMINAL_RETENTION_MAX_JOBS + 1 }), (_, index) =>
        Effect.gen(function* () {
          const latch = yield* Deferred.make<void>()
          const id = `job_retention_terminal_${index}`
          yield* jobs.start({ id, type: "test", run: Deferred.await(latch).pipe(Effect.as(`done-${index}`)) })
          return { id, latch }
        }),
      )
      const settled = yield* Effect.forEach(terminals, (terminal) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(terminal.latch, undefined)
          return yield* waitForTerminal(jobs, terminal.id)
        }),
      )
      const retained = yield* Effect.forEach(terminals, (terminal) => jobs.get(terminal.id))

      expect(new Set(settled.map((info) => info.completed_at)).size).toBe(1)
      expect(retained.filter((info) => info !== undefined)).toHaveLength(Job.TERMINAL_RETENTION_MAX_JOBS)
      expect(retained[0]).toBeUndefined()
      expect(retained.at(-1)).toMatchObject({ status: "completed", output: "done-128" })
      expect(yield* jobs.get(running.id)).toMatchObject({ status: "running" })

      yield* Deferred.succeed(runningLatch, undefined)
      expect(yield* jobs.wait({ id: running.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "running done" },
      })
    }),
  )

  it.effect("reserves the newest oversized terminal grace across unrelated consumption", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const normal = yield* Effect.forEach(Array.from({ length: Job.TERMINAL_RETENTION_MAX_JOBS }), (_, index) =>
        Effect.gen(function* () {
          const job = yield* jobs.start({
            id: `job_grace_normal_${index}`,
            type: "test",
            run: Effect.succeed(`normal-${index}`),
          })
          yield* waitForTerminal(jobs, job.id)
          return job.id
        }),
      )
      const output = "x".repeat(Math.floor(Job.TERMINAL_RETENTION_MAX_BYTES / 2) + 1)
      const oversized = yield* jobs.start({
        id: "job_grace_oversized",
        type: "test",
        run: Effect.succeed(output),
      })
      yield* waitForTerminal(jobs, oversized.id)

      expect(yield* jobs.get(normal[0]!)).toBeUndefined()
      expect(yield* jobs.get(normal.at(-1)!)).toMatchObject({ status: "completed" })
      expect(yield* jobs.get(oversized.id)).toMatchObject({ status: "completed" })

      expect(yield* jobs.wait({ id: normal.at(-1)! })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: `normal-${Job.TERMINAL_RETENTION_MAX_JOBS - 1}` },
      })
      expect(yield* jobs.get(oversized.id)).toMatchObject({ status: "completed" })

      const consumed = yield* jobs.wait({ id: oversized.id })
      expect(consumed.info?.output).toHaveLength(output.length)
      expect(yield* jobs.get(oversized.id)).toBeUndefined()
    }),
  )

  it.effect("delivers an evicted oversized terminal through wait and foreground block Deferreds", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const output = "x".repeat(Math.floor(Job.TERMINAL_RETENTION_MAX_BYTES / 2) + 1)
      const job = yield* jobs.start({
        id: "job_deferred_oversized",
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as(output)),
      })
      const scope = yield* Scope.Scope
      const waiting = yield* jobs.wait({ id: job.id }).pipe(Effect.forkIn(scope, { startImmediately: true }))
      const blocking = yield* jobs
        .block({ id: job.id, sessionID: SessionSchema.ID.make("ses_deferred_parent") })
        .pipe(Effect.forkIn(scope, { startImmediately: true }))

      yield* Effect.yieldNow
      yield* Deferred.succeed(latch, undefined)

      const waited = yield* Fiber.join(waiting)
      const blocked = yield* Fiber.join(blocking)
      expect(waited.info?.output).toHaveLength(output.length)
      expect(blocked).toMatchObject({ type: "finished", info: { output } })
      expect(yield* jobs.get(job.id)).toBeUndefined()
    }),
  )

  it.live("retains background ownership and terminal output until notification acknowledgment", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const recovery = {
        kind: "shell" as const,
        sessionID: SessionSchema.ID.make("ses_background_shell"),
        shellID: "shell_background",
        command: "echo done",
      }
      const job = yield* jobs.start({ type: "shell", recovery, run: Deferred.await(latch).pipe(Effect.as("done")) })

      expect((yield* jobs.pendingBackground).find((item) => item.id === job.id)).toBeUndefined()
      const background = yield* jobs.background(job.id)

      const running = (yield* jobs.pendingBackground).find((item) => item.id === job.id)
      expect(running).toMatchObject({ id: job.id, recovery, status: "running" })
      expect(running?.notificationID).toStartWith("msg_")
      expect(background?.notificationID).toBe(running?.notificationID)

      yield* Deferred.succeed(latch, undefined)
      yield* jobs.wait({ id: job.id })

      const completed = (yield* jobs.pendingBackground).find((item) => item.id === job.id)
      expect(completed).toMatchObject({
        id: job.id,
        notificationID: running?.notificationID,
        recovery,
        status: "completed",
        output: "done",
      })
      if (!completed) return yield* Effect.die("background marker missing")

      yield* jobs.completeBackground(completed.notificationID)
      expect((yield* jobs.pendingBackground).find((item) => item.id === job.id)).toBeUndefined()
    }),
  )

  it.live("persists backgroundAll ownership before releasing a blocked subagent", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const parentSessionID = SessionSchema.ID.make("ses_background_parent")
      const latch = yield* Deferred.make<void>()
      const recovery = {
        kind: "subagent" as const,
        parentSessionID,
        childSessionID: SessionSchema.ID.make("ses_background_child"),
        agent: "explore",
        description: "Explore background recovery",
      }
      const job = yield* jobs.start({ type: "subagent", recovery, run: Deferred.await(latch).pipe(Effect.as("done")) })
      const waiting = yield* jobs
        .block({ id: job.id, sessionID: parentSessionID })
        .pipe(Effect.forkIn(yield* Scope.Scope, { startImmediately: true }))

      yield* jobs.backgroundAll({ sessionID: parentSessionID })
      expect(yield* Fiber.join(waiting)).toMatchObject({ type: "backgrounded", info: { id: job.id } })

      const marker = (yield* jobs.pendingBackground).find((item) => item.id === job.id)
      expect(marker).toMatchObject({ id: job.id, recovery, status: "running" })
      if (!marker) return yield* Effect.die("background marker missing")

      yield* jobs.cancel(job.id)
      expect((yield* jobs.pendingBackground).find((item) => item.id === job.id)).toMatchObject({
        notificationID: marker.notificationID,
        status: "cancelled",
      })
      yield* jobs.completeBackground(marker.notificationID)
    }),
  )

  it.live("retains terminal errors for recovery until notification acknowledgment", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "shell",
        recovery: {
          kind: "shell",
          sessionID: SessionSchema.ID.make("ses_background_error"),
          shellID: "shell_error",
          command: "exit 1",
        },
        run: Deferred.await(latch).pipe(Effect.andThen(Effect.fail(new Error("shell failed")))),
      })

      yield* jobs.background(job.id)
      yield* Deferred.succeed(latch, undefined)
      yield* jobs.wait({ id: job.id })

      const marker = (yield* jobs.pendingBackground).find((item) => item.id === job.id)
      expect(marker).toMatchObject({ id: job.id, status: "error", error: "shell failed" })
      if (!marker) return yield* Effect.die("background marker missing")
      yield* jobs.completeBackground(marker.notificationID)
    }),
  )

  it.live("durably backgrounds recoverable work that has already failed", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const job = yield* jobs.start({
        type: "shell",
        recovery: {
          kind: "shell",
          sessionID: SessionSchema.ID.make("ses_immediate_error"),
          shellID: "shell_immediate_error",
          command: "exit 1",
        },
        run: Effect.fail(new Error("shell failed")),
      })
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("error")

      const background = yield* jobs.background(job.id)
      expect(background?.notificationID).toStartWith("msg_")
      expect(yield* jobs.pendingBackground).toMatchObject([
        { id: job.id, notificationID: background?.notificationID, status: "error", error: "shell failed" },
      ])
    }),
  )

  it.live("recovers a background marker after its process-local registry closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const previous = yield* Job.make.pipe(Scope.provide(scope))
      const job = yield* previous.start({
        type: "shell",
        recovery: {
          kind: "shell",
          sessionID: SessionSchema.ID.make("ses_background_restart"),
          shellID: "shell_restart",
          command: "sleep 60",
        },
        run: Effect.never,
      })
      yield* previous.background(job.id)
      yield* Scope.close(scope, Exit.void)

      const current = yield* Job.make
      const marker = (yield* current.pendingBackground).find((item) => item.id === job.id)
      expect(marker).toMatchObject({ id: job.id, status: "running" })
      if (!marker) return yield* Effect.die("background marker missing")
      yield* current.completeBackground(marker.notificationID)
    }),
  )

  it.live("preserves running background ownership when its work is interrupted", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const interrupted = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: SessionSchema.ID.make("ses_interrupted_parent"),
          childSessionID: SessionSchema.ID.make("ses_interrupted_child"),
          agent: "explore",
          description: "Continue after shutdown",
        },
        run: Deferred.await(interrupted).pipe(Effect.andThen(Effect.interrupt)),
      })
      yield* jobs.background(job.id)
      yield* Deferred.succeed(interrupted, undefined)
      yield* jobs.wait({ id: job.id })

      const marker = (yield* jobs.pendingBackground).find((item) => item.id === job.id)
      expect(marker).toMatchObject({ id: job.id, status: "running" })
      if (!marker) return yield* Effect.die("background marker missing")
      yield* jobs.completeBackground(marker.notificationID)
    }),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* Job.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )
})
