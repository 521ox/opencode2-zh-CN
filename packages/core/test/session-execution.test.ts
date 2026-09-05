import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIError, TransportError } from "@opencode-ai/ai"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Bus } from "@opencode-ai/core/bus"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Instance } from "@opencode-ai/core/instance/service"
import { Job } from "@opencode-ai/core/job"
import { KV } from "@opencode-ai/core/kv"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionContinuation } from "@opencode-ai/core/session/continuation"
import { SessionRestart } from "@opencode-ai/core/session/execution/restart"
import { UserInterruptedError } from "@opencode-ai/core/session/error"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInbox } from "@opencode-ai/core/session/inbox"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionRunner } from "@opencode-ai/core/session/runner/index"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import {
  SessionInboxTable,
  SessionSubagentContinuationTable,
  SessionSubagentTurnTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Context, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Scope } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionStore.node, Job.node, KV.node, Session.node])),
)
const testOwner: SessionStore.Owner = { id: "test-owner", pid: 0, hostname: "test", leaseMs: 30_000 }

describe("SessionExecution lifecycle", () => {
  test("classifies success and typed failure terminals", () => {
    expect(SessionExecution.terminal(Exit.succeed(undefined))).toEqual({ type: "succeeded" })
    expect(
      SessionExecution.terminal(
        Exit.fail(
          new AIError({
            reason: new TransportError({ message: "Disconnected", transport: "http", operation: "request" }),
          }),
        ),
      ),
    ).toEqual({ type: "failed", error: { type: "provider.transport", message: "Disconnected" } })
  })

  test("defaults owner-scope interruption to shutdown and preserves explicit reasons", () => {
    const interrupted = Effect.runSyncExit(Effect.interrupt)
    expect(SessionExecution.terminal(interrupted)).toEqual({ type: "interrupted", reason: "shutdown" })
    expect(SessionExecution.terminal(interrupted, "user")).toEqual({ type: "interrupted", reason: "user" })
    expect(SessionExecution.terminal(Exit.fail(new UserInterruptedError()))).toEqual({
      type: "interrupted",
      reason: "user",
    })
  })

  it.effect("the sweep only lists claimed top-level Sessions", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const parent = Session.ID.make("ses_recover_parent")
      const child = Session.ID.make("ses_recover_child")
      const idle = Session.ID.make("ses_recover_idle")
      yield* seedSessions(database, [parent], { time_suspended: Date.now() })
      yield* seedSessions(database, [idle])
      // Children recover through background Job records, never through the root claim sweep.
      yield* seedSessions(database, [child], { time_suspended: Date.now(), parent_id: parent })

      expect(yield* store.listSuspended()).toEqual([parent])

      // The sweep clears orphaned child claims outright; parents keep theirs.
      yield* store.releaseChildClaims([], testOwner)
      expect(yield* claims(database)).toEqual({ [parent]: true, [child]: false, [idle]: false })
    }),
  )

  it.effect("claims at execution start, releases on completion, and preserves through teardown", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const interrupted = Session.ID.make("ses_claim_interrupted")
      const completed = Session.ID.make("ses_claim_completed")
      yield* seedSessions(database, [interrupted, completed])

      // Each drain signals once it runs; the claim commits before the drain starts.
      const interruptedRunning = yield* Deferred.make<void>()
      const completedRunning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        sessionID === completed
          ? Deferred.succeed(completedRunning, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Deferred.succeed(interruptedRunning, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const shutdowns: SessionEvent.Execution.Interrupted[] = []
      yield* bus.project(SessionEvent.Execution.Interrupted, (event) => Effect.sync(() => void shutdowns.push(event)))
      yield* execution.resume(interrupted).pipe(Effect.forkScoped)
      const completing = yield* execution.resume(completed).pipe(Effect.forkIn(scope))
      yield* Deferred.await(interruptedRunning)
      yield* Deferred.await(completedRunning)

      // The write-ahead claim exists WHILE the turns run — no shutdown hook involved.
      expect(yield* claims(database)).toEqual({ [interrupted]: true, [completed]: true })

      // A drain that finishes on its own releases its claim.
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(completing)
      yield* execution.awaitIdle(completed)
      expect((yield* claims(database))[completed]).toBe(false)

      // Teardown interruption (graceful twin of an unclean death) preserves the claim
      // for the next server start.
      yield* Scope.close(scope, Exit.void)
      expect((yield* claims(database))[interrupted]).toBe(true)
      expect(shutdowns.map((event) => event.data.reason)).toEqual(["shutdown"])
      expect((yield* lease(database, interrupted))?.expires).toBeLessThanOrEqual(Date.now())
    }),
  )

  it.effect("a user interrupt releases the claim so the turn never resurrects", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_claim_user_cancel")
      yield* seedSessions(database, [sessionID])

      const draining = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)
      expect((yield* claims(database))[sessionID]).toBe(true)

      expect(yield* execution.interrupt(sessionID)).toBeTrue()
      yield* execution.awaitIdle(sessionID)
      expect((yield* claims(database))[sessionID]).toBe(false)
    }),
  )

  it.effect("reports an idle interrupt as a no-op", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_idle_cancel")
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.never)
      const execution = Context.get(context, SessionExecution.Service)

      expect(yield* execution.interrupt(sessionID)).toBeFalse()
      expect(yield* execution.active).not.toContain(sessionID)
    }),
  )

  it.effect("does not resume a user-cancelled background child whose notification was not admitted", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const parent = Session.ID.make("ses_cancelled_background_parent")
      const child = Session.ID.make("ses_cancelled_background_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })

      const running = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const jobs = yield* Job.make.pipe(Scope.provide(scope))
      const context = yield* buildExecution(
        scope,
        () => Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never)),
        undefined,
        jobs,
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "general",
          description: "Cancelled inspection",
        },
        run: execution.resume(child).pipe(Effect.as("unused")),
      })
      yield* jobs.background(child)
      yield* Deferred.await(running)
      expect(yield* execution.interrupt(child)).toBeTrue()
      yield* execution.awaitIdle(child)
      expect((yield* jobs.wait({ id: child })).info?.status).toBe("cancelled")
      expect(yield* jobs.pendingBackground).toMatchObject([{ id: child, status: "cancelled" }])
      expect((yield* claims(database))[child]).toBe(false)
      yield* Scope.close(scope, Exit.void)

      const restartedScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(restartedScope, Exit.void))
      const restartedJobs = yield* Job.make.pipe(Scope.provide(restartedScope))
      const drained: Session.ID[] = []
      const restarted = yield* buildExecution(
        restartedScope,
        ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)),
        undefined,
        restartedJobs,
      )
      yield* Context.get(restarted, SessionRestart.Service).resumeSuspendedSessions
      yield* Context.get(restarted, SessionExecution.Service).awaitIdle(parent)
      expect(drained).toEqual([parent])
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        { payload: { text: expect.stringContaining("Subagent cancelled"), metadata: { state: "cancelled" } } },
      ])
      expect(yield* restartedJobs.pendingBackground).toEqual([])
    }),
  )

  it.effect("starts every claimed execution without waiting for earlier drains to finish", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionIDs = Array.from({ length: 5 }, (_, index) => Session.ID.make(`ses_resume_concurrent_${index}`))
      yield* seedSessions(database, sessionIDs, { time_suspended: Date.now() })

      const fourStarted = yield* Deferred.make<void>()
      const started: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        Effect.sync(() => {
          started.push(sessionID)
          if (started.length === 4) Deferred.doneUnsafe(fourStarted, Effect.void)
        }).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)
      yield* restart.resumeSuspendedSessions.pipe(Effect.forkIn(scope))
      yield* Deferred.await(fourStarted)

      expect([...(yield* execution.active)].toSorted()).toEqual(sessionIDs.toSorted())
    }),
  )

  it.effect("resumes each claimed Session at most once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const first = Session.ID.make("ses_resume_first")
      const second = Session.ID.make("ses_resume_second")
      yield* seedSessions(database, [first, second], { time_suspended: Date.now() })

      const drained: string[] = []
      const bothDraining = yield* Deferred.make<void>()
      const continued: SessionEvent.Synthetic[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        Effect.sync(() => {
          drained.push(sessionID)
          if (drained.length === 2) Deferred.doneUnsafe(bothDraining, Effect.void)
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)
      yield* bus.project(SessionEvent.Synthetic, (event) => Effect.sync(() => void continued.push(event)))

      // The sweep forks resumed drains, so completion is observed through the executions.
      yield* restart.resumeSuspendedSessions
      yield* Deferred.await(bothDraining)
      yield* Effect.forEach([first, second], execution.awaitIdle, { discard: true })
      expect(drained.toSorted()).toEqual([first, second])
      expect(continued.map((event) => event.data).toSorted((a, b) => a.sessionID.localeCompare(b.sessionID))).toEqual(
        [first, second].map((sessionID) => ({
          sessionID,
          text: "The server restarted while you were working. Continue from where you left off without repeating completed work.",
          description: "Continuing after restart",
        })),
      )
      // Drains completed naturally, so claims are released and counters reset.
      expect(yield* claims(database)).toEqual({ [first]: false, [second]: false })
      expect(yield* attempts(database, first)).toBe(0)

      yield* restart.resumeSuspendedSessions
      expect(drained.length).toBe(2)
      expect(continued.length).toBe(2)
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("terminalizes a turn that exhausts its resume budget instead of crash-looping", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const sessionID = Session.ID.make("ses_resume_exhausted")
      // A claim from a dead process, already resumed twice without completing.
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now(), resume_attempts: 2 })

      const drained: string[] = []
      const failures: SessionEvent.Execution.Failed[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID: id }) => Effect.sync(() => void drained.push(id)), {
        maxAttempts: 2,
      })
      const restart = Context.get(context, SessionRestart.Service)
      yield* bus.project(SessionEvent.Execution.Failed, (event) => Effect.sync(() => void failures.push(event)))

      yield* restart.resumeSuspendedSessions
      expect(drained).toEqual([])
      expect(failures.map((event) => event.data.error.type)).toEqual(["aborted"])
      // The terminal released the claim and reset the counter atomically.
      expect(yield* claims(database)).toEqual({ [sessionID]: false })
      expect(yield* attempts(database, sessionID)).toBe(0)
    }),
  )

  it.effect("counts every resume durably and never consumes the claim it recovers", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_resume_counted")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })

      const draining = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      // The drain never terminalizes (mirrors a process that will die mid-turn).
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const restart = Context.get(context, SessionRestart.Service)
      yield* restart.resumeSuspendedSessions.pipe(Effect.forkIn(scope))
      yield* Deferred.await(draining)

      // The attempt is durable before the drain runs, and the claim is held
      // throughout: a crash anywhere in the resume path leaves both intact.
      expect(yield* attempts(database, sessionID)).toBe(1)
      expect((yield* claims(database))[sessionID]).toBe(true)

      // Teardown (a graceful shutdown's interrupt) preserves both, so the next
      // boot counts attempt 2 against the same turn.
      yield* Scope.close(scope, Exit.void)
      expect((yield* claims(database))[sessionID]).toBe(true)
      expect(yield* attempts(database, sessionID)).toBe(1)
    }),
  )

  it.effect("the sweep leaves Sessions already draining in this process untouched", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const sessionID = Session.ID.make("ses_resume_local_active")
      yield* seedSessions(database, [sessionID])

      const draining = yield* Deferred.make<void>()
      const continued: SessionEvent.Synthetic[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)
      yield* bus.project(SessionEvent.Synthetic, (event) => Effect.sync(() => void continued.push(event)))

      // A live local turn holds a claim; the sweep must not count, continue, or terminalize it.
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)
      yield* restart.resumeSuspendedSessions

      expect(continued).toEqual([])
      expect(yield* attempts(database, sessionID)).toBe(0)
      expect((yield* claims(database))[sessionID]).toBe(true)
    }),
  )

  it.effect("rejects foreign lease mutations while the owner is fresh", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const sessionID = Session.ID.make("ses_foreign_lease")
      const ownerA: SessionStore.Owner = { id: "owner-a", pid: 1, hostname: "host-a", leaseMs: 60_000 }
      const ownerB: SessionStore.Owner = { id: "owner-b", pid: 2, hostname: "host-b", leaseMs: 60_000 }
      yield* seedSessions(database, [sessionID])

      expect(yield* store.claim(sessionID, ownerA)).toBeTrue()
      expect(yield* store.claim(sessionID, ownerB)).toBeFalse()
      expect(yield* store.touch(sessionID, ownerB)).toBeFalse()
      expect(yield* store.countResume(sessionID, ownerB)).toBeUndefined()
      expect(yield* store.release(sessionID, ownerB)).toBeFalse()
      expect(yield* store.countResume(sessionID, ownerA)).toBe(1)
      expect(yield* store.release(sessionID, ownerA)).toBeTrue()
      expect(yield* lease(database, sessionID)).toMatchObject({ owner: null, expires: null, attempts: 0 })
    }),
  )

  it.effect("reports a foreign wake and lets the ordinary wake acquire after that owner releases", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const sessionID = Session.ID.make("ses_foreign_wake_reconcile")
      yield* seedSessions(database, [sessionID])
      const foreignScope = yield* Scope.make()
      const localScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(foreignScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(localScope, Exit.void))
      const foreign = Context.get(yield* buildExecution(foreignScope, () => Effect.void), SessionExecution.Service)
      const drained: Session.ID[] = []
      const local = Context.get(
        yield* buildExecution(localScope, ({ sessionID: id }) => Effect.sync(() => void drained.push(id))),
        SessionExecution.Service,
      )
      if (!foreign.claim || !foreign.owner) return yield* Effect.die("Production lease controls are unavailable")

      expect(yield* foreign.claim(sessionID)).toBeTrue()
      expect(yield* local.wake(sessionID)).toEqual({ type: "foreign" })
      expect(drained).toEqual([])

      expect(yield* store.release(sessionID, foreign.owner)).toBeTrue()
      expect(yield* local.wake(sessionID)).toEqual({ type: "owned" })
      yield* local.awaitIdle(sessionID)
      expect(drained).toEqual([sessionID])
    }),
  )

  it.effect("rolls back a terminal when the lease is taken after the final touch", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const sessionID = Session.ID.make("ses_terminal_commit_fence")
      const owner = { ...testOwner, id: "terminal-owner" }
      yield* seedSessions(database, [sessionID])

      expect(yield* store.claim(sessionID, owner)).toBeTrue()
      expect(yield* store.touch(sessionID, owner)).toBeTrue()
      yield* takeLease(database, sessionID, "terminal-takeover")

      const exit = yield* bus
        .publish(
          SessionEvent.Execution.Succeeded,
          { sessionID },
          {
            commit: () =>
              store
                .release(sessionID, owner)
                .pipe(Effect.flatMap(SessionStore.requireOwnership(sessionID, owner, "terminal commit"))),
          },
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Session execution lease lost before terminal commit")
      expect(yield* durableEvents(database, sessionID)).toEqual([])
      expect(yield* lease(database, sessionID)).toMatchObject({ owner: "terminal-takeover" })
    }),
  )

  it.effect("rolls back restart continuation when the lease is taken after counting resume", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const sessionID = Session.ID.make("ses_restart_continuation_fence")
      const owner = { ...testOwner, id: "restart-owner" }
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })

      expect(yield* store.claim(sessionID, owner)).toBeTrue()
      expect(yield* store.countResume(sessionID, owner)).toBe(1)
      yield* takeLease(database, sessionID, "restart-takeover")

      const exit = yield* bus
        .publish(
          SessionEvent.Synthetic,
          {
            sessionID,
            text: "Continue after takeover",
            description: "Continuing after restart",
          },
          {
            commit: () =>
              store
                .touch(sessionID, owner)
                .pipe(Effect.flatMap(SessionStore.requireOwnership(sessionID, owner, "restart continuation commit"))),
          },
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Session execution lease lost before restart continuation commit")
      expect(yield* durableEvents(database, sessionID)).toEqual([])
      expect(yield* attempts(database, sessionID)).toBe(1)
      expect(yield* lease(database, sessionID)).toMatchObject({ owner: "restart-takeover" })
    }),
  )

  it.effect("allows an expired lease takeover without resetting the resume budget", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const sessionID = Session.ID.make("ses_expired_lease")
      const ownerB: SessionStore.Owner = { id: "owner-b", pid: 2, hostname: "host-b", leaseMs: 60_000 }
      yield* seedSessions(database, [sessionID], {
        time_suspended: Date.now() - 10_000,
        resume_attempts: 2,
        claim_owner: "owner-a",
        claim_pid: 1,
        claim_hostname: "host-a",
        claim_updated_at: Date.now() - 10_000,
        claim_expires_at: Date.now() - 1,
      })

      expect(yield* store.claim(sessionID, ownerB)).toBeTrue()
      expect(yield* store.countResume(sessionID, ownerB)).toBe(3)
      expect(yield* lease(database, sessionID)).toMatchObject({ owner: ownerB.id, attempts: 3 })
    }),
  )

  it.effect("skips restart side effects for a foreign fresh lease", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const sessionID = Session.ID.make("ses_foreign_restart")
      yield* seedSessions(database, [sessionID], {
        time_suspended: Date.now(),
        claim_owner: "foreign-owner",
        claim_pid: 99,
        claim_hostname: "foreign-host",
        claim_updated_at: Date.now(),
        claim_expires_at: Date.now() + 60_000,
      })

      const drained: Session.ID[] = []
      const continued: SessionEvent.Synthetic[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) => Effect.sync(() => void drained.push(input.sessionID)))
      const restart = Context.get(context, SessionRestart.Service)
      yield* bus.project(SessionEvent.Synthetic, (event) => Effect.sync(() => void continued.push(event)))

      yield* restart.resumeSuspendedSessions

      expect(drained).toEqual([])
      expect(continued).toEqual([])
      expect(yield* attempts(database, sessionID)).toBe(0)
      expect(yield* lease(database, sessionID)).toMatchObject({ owner: "foreign-owner" })
    }),
  )

  it.effect("does not clear a fresh child lease during restart cleanup", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const parentID = Session.ID.make("ses_child_parent")
      const childID = Session.ID.make("ses_child_fresh")
      yield* seedSessions(database, [parentID])
      yield* seedSessions(database, [childID], {
        parent_id: parentID,
        time_suspended: Date.now(),
        claim_owner: testOwner.id,
        claim_pid: testOwner.pid,
        claim_hostname: testOwner.hostname,
        claim_updated_at: Date.now(),
        claim_expires_at: Date.now() + 60_000,
      })

      yield* store.releaseChildClaims([], testOwner)
      expect(yield* lease(database, childID)).toMatchObject({ owner: testOwner.id })

      yield* database.db
        .update(SessionTable)
        .set({ claim_expires_at: Date.now() - 1 })
        .where(eq(SessionTable.id, childID))
        .run()
        .pipe(Effect.orDie)
      yield* store.releaseChildClaims([], testOwner)
      expect(yield* lease(database, childID)).toMatchObject({ owner: null, expires: null })
    }),
  )

  it.effect("does not publish a terminal after another owner takes the lease", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const sessionID = Session.ID.make("ses_lost_terminal_owner")
      yield* seedSessions(database, [sessionID])

      const draining = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const succeeded: SessionEvent.Execution.Succeeded[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(draining, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* bus.project(SessionEvent.Execution.Succeeded, (event) => Effect.sync(() => void succeeded.push(event)))
      const running = yield* execution.resume(sessionID).pipe(Effect.forkIn(scope))
      yield* Deferred.await(draining)

      yield* takeLease(database, sessionID, "foreign-owner")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)

      expect(succeeded).toEqual([])
      expect(yield* lease(database, sessionID)).toMatchObject({ owner: "foreign-owner" })
    }),
  )
})

test("serializes lease claims across Windows processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-session-lease-"))
  const databasePath = join(root, "lease.db")
  const gatePath = join(root, "go")
  const sessionID = "ses_process_lease"
  const database = new (await import("bun:sqlite")).Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE session_v2 (
        id text PRIMARY KEY NOT NULL,
        time_suspended integer,
        resume_attempts integer DEFAULT 0 NOT NULL,
        claim_owner text,
        claim_pid integer,
        claim_hostname text,
        claim_updated_at integer,
        claim_expires_at integer
      );
    `)
    database.query("INSERT INTO session_v2 (id) VALUES (?)").run(sessionID)

    const fixture = join(import.meta.dir, "fixture", "session-lease-worker.ts")
    const spawn = (ownerID: string) =>
      Bun.spawn({
        cmd: [process.execPath, fixture, databasePath, sessionID, ownerID, gatePath],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      })
    const ownerA = spawn("owner-a")
    const ownerB = spawn("owner-b")
    await Bun.sleep(25)
    await Bun.write(gatePath, "go")

    const [stdoutA, stdoutB, stderrA, stderrB, exitA, exitB] = await Promise.all([
      new Response(ownerA.stdout).text(),
      new Response(ownerB.stdout).text(),
      new Response(ownerA.stderr).text(),
      new Response(ownerB.stderr).text(),
      ownerA.exited,
      ownerB.exited,
    ])

    if (exitA !== 0 || exitB !== 0)
      throw new Error(`lease workers failed: A=${exitA} ${stderrA.trim()} B=${exitB} ${stderrB.trim()}`)
    const parseWorker = (text: string) => {
      const output: unknown = JSON.parse(text)
      if (
        typeof output !== "object" ||
        output === null ||
        !("ownerID" in output) ||
        typeof output.ownerID !== "string" ||
        !("claimed" in output) ||
        typeof output.claimed !== "boolean"
      )
        throw new Error("Invalid lease worker output")
      return { ownerID: output.ownerID, claimed: output.claimed }
    }
    const outputA = parseWorker(stdoutA)
    const outputB = parseWorker(stdoutB)
    expect([outputA, outputB].filter((output) => output.claimed)).toHaveLength(1)
    expect(database.query("SELECT claim_owner AS owner FROM session_v2 WHERE id = ?").get(sessionID)).toEqual({
      owner: [outputA, outputB].find((output) => output.claimed)?.ownerID,
    })
  } finally {
    database.close(false)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe("SessionRestart background recovery", () => {
  it.effect("wakes idle shell owners and delivers recovered notices exactly once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const jobs = yield* Job.Service
      const bus = yield* Bus.Service
      const parent = Session.ID.make("ses_background_recovery_parent")
      const child = Session.ID.make("ses_background_recovery_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now() })
      yield* seedBackground(jobs, parent, [
        { id: "call-background-shell", shellID: "sh_background_orphan", command: "sleep 60" },
      ])
      yield* seedBackground(jobs, child, [{ id: "call-child-shell", shellID: "sh_child_orphan", command: "sleep 30" }])

      expect(yield* store.listSuspended()).toEqual([])
      expect(yield* jobs.pendingBackground).toHaveLength(2)

      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(SessionInbox.promote(database.db, bus, sessionID, "steer")),
            Effect.asVoid,
          ),
        undefined,
        restarted,
      )
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* Effect.forEach([parent, child], execution.awaitIdle, { discard: true })

      expect(drained.toSorted()).toEqual([parent, child].toSorted())
      expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toMatchObject([
        {
          type: "synthetic",
          description: "sleep 60",
          text: expect.stringContaining("server restarted"),
          metadata: {
            source: "shell",
            jobID: "call-background-shell",
            shellID: "sh_background_orphan",
            state: "cancelled",
          },
        },
      ])
      expect((yield* store.context(child)).filter((message) => message.type === "synthetic")).toMatchObject([
        {
          type: "synthetic",
          metadata: {
            source: "shell",
            jobID: "call-child-shell",
            shellID: "sh_child_orphan",
            state: "cancelled",
          },
        },
      ])
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
      expect(yield* SessionInbox.list(database.db, child)).toEqual([])
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
      expect(yield* restarted.pendingBackground).toEqual([])

      yield* restart.resumeSuspendedSessions
      expect(drained).toHaveLength(2)
      expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toHaveLength(1)
      expect((yield* store.context(child)).filter((message) => message.type === "synthetic")).toHaveLength(1)
    }),
  )

  it.effect("preserves locally running background work", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_background_existing_parent")
      yield* seedSessions(database, [parent])
      yield* seedBackground(jobs, parent, [{ id: "call-running-shell", shellID: "sh_running", command: "sleep 60" }])

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.void)
      const restart = Context.get(context, SessionRestart.Service)
      yield* restart.resumeSuspendedSessions

      expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toEqual([])
      expect(yield* jobs.get("call-running-shell")).toMatchObject({ status: "running" })
      expect(yield* jobs.pendingBackground).toHaveLength(1)
    }),
  )

  it.effect("wakes the owner for a silent shell failure persisted before its completion notification", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_background_completed_shell")
      yield* seedSessions(database, [sessionID])
      const complete = yield* Deferred.make<string>()
      yield* jobs.start({
        id: "call-completed-shell",
        type: "shell",
        recovery: {
          kind: "shell",
          sessionID,
          shellID: "sh_completed",
          command: "exit 7",
        },
        run: Deferred.await(complete),
      })
      yield* jobs.background("call-completed-shell")
      yield* Deferred.succeed(complete, "(no output)\n\nCommand exited with code 7.")
      yield* jobs.wait({ id: "call-completed-shell" })

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const drained: Session.ID[] = []
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)),
        undefined,
        restarted,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Context.get(context, SessionExecution.Service).awaitIdle(sessionID)

      expect(drained).toEqual([sessionID])
      expect(yield* SessionInbox.list(database.db, sessionID)).toMatchObject([
        {
          type: "synthetic",
          payload: {
            text: expect.stringContaining("(no output)\n\nCommand exited with code 7."),
            metadata: { source: "shell", shellID: "sh_completed", state: "completed" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  for (const delivered of [false, true]) {
    it.effect(`does not duplicate a shell notification already ${delivered ? "delivered" : "admitted"}`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const jobs = yield* Job.Service
        const sessions = yield* Session.Service
        const sessionID = Session.ID.make("ses_shell_notification_retry")
        yield* seedSessions(database, [sessionID])
        yield* seedBackground(jobs, sessionID, [
          { id: "call-shell-notified", shellID: "sh_notified", command: "echo done" },
        ])
        const background = (yield* jobs.pendingBackground)[0]
        if (!background) return yield* Effect.die("background record missing")
        yield* sessions.synthetic({
          id: background.notificationID,
          sessionID,
          text: "Command already completed",
          metadata: { source: "shell", shellID: "sh_notified", state: "completed" },
          resume: false,
        })
        if (delivered) yield* SessionInbox.promote(database.db, bus, sessionID, "steer")

        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
        const context = yield* buildExecution(scope, () => Effect.void, undefined, restarted)
        yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

        expect(yield* restarted.pendingBackground).toEqual([])
        expect(yield* SessionInbox.list(database.db, sessionID)).toHaveLength(delivered ? 0 : 1)
        yield* SessionInbox.promote(database.db, bus, sessionID, "steer")
        expect(yield* sessions.messages({ sessionID })).toMatchObject([
          {
            id: background.notificationID,
            type: "synthetic",
            text: "Command already completed",
            metadata: { state: "completed" },
          },
        ])
        expect(yield* sessions.messages({ sessionID })).toHaveLength(1)
      }),
    )
  }

  it.effect("acknowledges recovery markers when their owning session is deleted", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_background_deleted")
      yield* seedSessions(database, [sessionID])
      yield* seedBackground(jobs, sessionID, [{ id: "call-deleted-shell", shellID: "sh_deleted", command: "sleep 60" }])
      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(scope, () => Effect.void, undefined, restarted)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("delivers cancellation at the resumed parent's next step", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const store = yield* SessionStore.Service
      const bus = yield* Bus.Service
      const parent = Session.ID.make("ses_background_claimed_parent")
      yield* seedSessions(database, [parent], { time_suspended: Date.now() })
      yield* seedBackground(jobs, parent, [{ id: "call-claimed-shell", shellID: "sh_claimed", command: "sleep 60" }])

      const observed = yield* Deferred.make<string[]>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          SessionInbox.promote(database.db, bus, sessionID, "steer").pipe(
            Effect.andThen(store.context(sessionID)),
            Effect.orDie,
            Effect.flatMap((messages) =>
              Deferred.succeed(
                observed,
                messages.filter((message) => message.type === "synthetic").map((message) => message.text),
              ),
            ),
            Effect.asVoid,
          ),
        undefined,
        restarted,
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      expect(yield* Deferred.await(observed)).toEqual([
        "The server restarted while you were working. Continue from where you left off without repeating completed work.",
        expect.stringContaining("Command cancelled because the server restarted"),
      ])
      yield* execution.awaitIdle(parent)
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
      expect((yield* claims(database))[parent]).toBe(false)
    }),
  )

  it.effect("does not bypass a claimed owner's restart budget for a shell notice", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_shell_recovery_exhausted")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now(), resume_attempts: 2 })
      yield* seedBackground(jobs, sessionID, [
        { id: "call-exhausted-shell", shellID: "sh_exhausted", command: "sleep 60" },
      ])

      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Scope.provide(scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)),
        { maxAttempts: 2 },
        restarted,
      )
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* execution.awaitIdle(sessionID)

      expect(drained).toEqual([])
      expect(yield* claims(database)).toEqual({ [sessionID]: false })
      expect(yield* attempts(database, sessionID)).toBe(0)
      expect(yield* SessionInbox.list(database.db, sessionID)).toMatchObject([
        { payload: { metadata: { source: "shell", state: "cancelled" } } },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
      yield* restart.resumeSuspendedSessions
      expect(drained).toEqual([])
    }),
  )

  for (const shellFirst of [false, true]) {
    for (const resumeAttempts of [1, 2]) {
      it.effect(
        `recovers a child's shell ${shellFirst ? "before" : "after"} its job record without bypassing attempt ${resumeAttempts + 1}`,
        () =>
          Effect.gen(function* () {
            const database = yield* Database.Service
            const jobs = yield* Job.Service
            const bus = yield* Bus.Service
            const store = yield* SessionStore.Service
            const parent = Session.ID.make("ses_shell_child_parent")
            const child = Session.ID.make("ses_shell_child")
            yield* seedSessions(database, [parent])
            yield* seedSessions(database, [child], {
              parent_id: parent,
              time_suspended: Date.now(),
              resume_attempts: resumeAttempts,
            })
            const shell = seedBackground(jobs, child, [
              { id: "call-child-shell", shellID: "sh_child", command: "sleep 60" },
            ])
            if (shellFirst) yield* shell
            yield* jobs.start({
              id: child,
              type: "subagent",
              recovery: {
                kind: "subagent",
                parentSessionID: parent,
                childSessionID: child,
                agent: "explore",
                description: "Inspect recovery",
              },
              run: Effect.never,
            })
            yield* jobs.background(child)
            if (!shellFirst) yield* shell
            expect((yield* jobs.pendingBackground).map((job) => job.recovery.kind)).toEqual(
              shellFirst ? ["shell", "subagent"] : ["subagent", "shell"],
            )

            const observed = yield* Deferred.make<{ attempts: number | undefined; notices: string[] }>()
            const release = yield* Deferred.make<void>()
            const parentWoken = yield* Deferred.make<void>()
            const drained: Session.ID[] = []
            const scope = yield* Scope.make()
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
            const restarted = yield* Job.make.pipe(Scope.provide(scope))
            const context = yield* buildExecution(
              scope,
              ({ sessionID }) =>
                Effect.gen(function* () {
                  drained.push(sessionID)
                  yield* SessionInbox.promote(database.db, bus, sessionID, "steer")
                  if (sessionID === parent) {
                    yield* Deferred.succeed(parentWoken, undefined)
                    return
                  }
                  yield* Deferred.succeed(observed, {
                    attempts: yield* attempts(database, sessionID),
                    notices: (yield* store.context(sessionID))
                      .filter((message) => message.type === "synthetic")
                      .map((message) => message.text),
                  })
                  yield* Deferred.await(release)
                }),
              { maxAttempts: 2 },
              restarted,
            )
            const restart = Context.get(context, SessionRestart.Service)
            const execution = Context.get(context, SessionExecution.Service)
            yield* restart.resumeSuspendedSessions

            if (resumeAttempts < 2) {
              expect(yield* Deferred.await(observed)).toEqual({
                attempts: 2,
                notices: [
                  expect.stringContaining("The server restarted while you were working"),
                  expect.stringContaining("Command cancelled because the server restarted"),
                ],
              })
              expect(drained).toEqual([child])
              expect(yield* execution.active).not.toContain(parent)
              expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
            }
            yield* Deferred.succeed(release, undefined)
            yield* Deferred.await(parentWoken)
            yield* Effect.forEach([parent, child], execution.awaitIdle, { discard: true })
            expect(drained).toEqual(resumeAttempts < 2 ? [child, parent] : [parent])
            expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toMatchObject([
              { metadata: { source: "subagent", childID: child, state: resumeAttempts < 2 ? "completed" : "error" } },
            ])
            expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
            expect(yield* attempts(database, child)).toBe(0)
            expect(yield* restarted.pendingBackground).toEqual([])

            yield* restart.resumeSuspendedSessions
            expect(drained).toHaveLength(resumeAttempts < 2 ? 2 : 1)
          }),
      )
    }
  }

  it.effect("resumes a background subagent and notifies its parent exactly once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_subagent_recovery_parent")
      const child = Session.ID.make("ses_subagent_recovery_child")
      const unrelated = Session.ID.make("ses_subagent_unrelated_child")
      yield* seedSessions(database, [parent], { time_suspended: Date.now(), resume_attempts: 1 })
      yield* seedSessions(database, [child, unrelated], { parent_id: parent, time_suspended: Date.now() })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Inspect recovery",
        },
        run: Effect.never,
      })
      yield* jobs.background(child)

      const resumed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const parentResumed = yield* Deferred.make<void>()
      const parentWoken = yield* Deferred.make<void>()
      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.gen(function* () {
            drained.push(sessionID)
            if (sessionID === child) {
              yield* Deferred.succeed(resumed, undefined)
              yield* Deferred.await(release)
              return
            }
            yield* Deferred.succeed(
              drained.filter((id) => id === parent).length === 1 ? parentResumed : parentWoken,
              undefined,
            )
          }),
        undefined,
        restarted,
      )
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* Deferred.await(resumed)
      yield* Deferred.await(parentResumed)
      yield* execution.awaitIdle(parent)

      yield* restart.resumeSuspendedSessions
      expect(drained.toSorted()).toEqual([child, parent].toSorted())
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: true, [unrelated]: false })
      expect(yield* attempts(database, child)).toBe(1)
      expect(yield* restarted.get(child)).toMatchObject({ status: "running" })

      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(parentWoken)
      expect(drained.filter((id) => id === child)).toHaveLength(1)
      expect(drained.filter((id) => id === parent)).toHaveLength(2)
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        {
          payload: {
            description: "Inspect recovery",
            metadata: { source: "subagent", childID: child, agent: "explore", state: "completed" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
      yield* restart.resumeSuspendedSessions
      expect(yield* SessionInbox.list(database.db, parent)).toHaveLength(1)
    }),
  )

  it.effect("delivers a subagent result persisted before restart without rerunning the child", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_subagent_completed_parent")
      const child = Session.ID.make("ses_subagent_completed_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      const complete = yield* Deferred.make<string>()
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Completed inspection",
        },
        run: Deferred.await(complete),
      })
      yield* jobs.background(child)
      yield* Deferred.succeed(complete, "Recovered result")
      yield* jobs.wait({ id: child })

      const parentWoken = yield* Deferred.make<void>()
      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(Deferred.succeed(parentWoken, undefined)),
          ),
        undefined,
        restarted,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Deferred.await(parentWoken)

      expect(drained).toEqual([parent])
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        { payload: { text: expect.stringContaining("Recovered result"), metadata: { state: "completed" } } },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect(
    "recovers a continuation-aware background terminal from its private output without rerunning the child",
    () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const jobs = yield* Job.Service
        const parent = Session.ID.make("ses_continuation_terminal_parent")
        const child = Session.ID.make("ses_continuation_terminal_child")
        const requestID = "sc_recovered_terminal"
        const turnID = "turn_recovered_terminal"
        const notificationID = SessionMessage.ID.make("msg_recovered_terminal_notice")
        yield* seedSessions(database, [parent])
        yield* seedSessions(database, [child], { parent_id: parent })
        yield* database.db
          .insert(SessionSubagentTurnTable)
          .values({
            id: turnID,
            child_session_id: child,
            state: "completed",
            output: "private full recovered conclusion",
            time_terminal: 1,
            time_created: 1,
            time_updated: 1,
          })
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionSubagentContinuationTable)
          .values({
            id: requestID,
            parent_session_id: parent,
            parent_message_id: SessionMessage.ID.make("msg_recovery_parent"),
            parent_tool_call_id: "call_recovery",
            child_session_id: child,
            agent: "reviewer",
            description: "Recover exact terminal",
            inbox_id: SessionMessage.ID.make("msg_recovery_inbox"),
            turn_id: turnID,
            state: "completed",
            prompt_digest: "digest",
            time_terminal: 1,
            time_created: 1,
            time_updated: 1,
          })
          .run()
          .pipe(Effect.orDie)
        const waiterID = SessionContinuation.waiterID(requestID)
        yield* jobs.start({
          id: waiterID,
          type: "subagent",
          notificationID,
          recovery: {
            kind: "subagent",
            parentSessionID: parent,
            childSessionID: child,
            agent: "reviewer",
            description: "Recover exact terminal",
            continuationID: requestID,
          },
          run: Effect.never,
        })
        yield* jobs.background(waiterID)

        const parentWoken = yield* Deferred.make<void>()
        const drained: Session.ID[] = []
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
        const context = yield* buildExecution(
          scope,
          ({ sessionID }) =>
            Effect.sync(() => void drained.push(sessionID)).pipe(
              Effect.andThen(sessionID === parent ? Deferred.succeed(parentWoken, undefined) : Effect.void),
            ),
          undefined,
          restarted,
        )
        const restart = Context.get(context, SessionRestart.Service)
        yield* restart.resumeSuspendedSessions
        yield* Deferred.await(parentWoken)

        expect(drained).toEqual([parent])
        expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
          {
            payload: {
              text: expect.stringContaining("private full recovered conclusion"),
              metadata: { source: "subagent", childID: child, state: "completed" },
            },
          },
        ])
        expect(yield* restarted.pendingBackground).toEqual([])
      }),
  )

  it.effect("observes a foreign-owned continuation terminal without another restart", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_foreign_continuation_parent")
      const child = Session.ID.make("ses_foreign_continuation_child")
      const requestID = "sc_foreign_continuation"
      const turnID = "turn_foreign_continuation"
      const notificationID = SessionMessage.ID.make("msg_foreign_continuation_notice")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      yield* database.db
        .insert(SessionSubagentTurnTable)
        .values({
          id: turnID,
          child_session_id: child,
          state: "active",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionSubagentContinuationTable)
        .values({
          id: requestID,
          parent_session_id: parent,
          parent_message_id: SessionMessage.ID.make("msg_foreign_continuation_parent"),
          parent_tool_call_id: "call_foreign_continuation",
          child_session_id: child,
          agent: "reviewer",
          description: "Observe foreign terminal",
          inbox_id: SessionMessage.ID.make("msg_foreign_continuation_inbox"),
          turn_id: turnID,
          state: "bound",
          prompt_digest: "digest",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* takeLease(database, child, "foreign-owner")
      const waiterID = SessionContinuation.waiterID(requestID)
      yield* jobs.start({
        id: waiterID,
        type: "subagent",
        notificationID,
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "reviewer",
          description: "Observe foreign terminal",
          continuationID: requestID,
        },
        run: Effect.never,
      })
      yield* jobs.background(waiterID)

      const notifications: SessionEvent.InboxEnqueued[] = []
      yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
        Effect.sync(() => {
          if (event.data.sessionID === parent && event.data.item.type === "synthetic") notifications.push(event)
        }),
      )
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(scope, () => Effect.void, undefined, restarted)
      const restart = Context.get(context, SessionRestart.Service)
      const foreign = yield* SessionContinuation.make(database.db, bus)

      yield* restart.resumeSuspendedSessions
      yield* Effect.yieldNow
      expect(yield* restarted.get(waiterID)).toMatchObject({ status: "running" })
      expect(yield* attempts(database, child)).toBe(0)

      const terminalized = yield* foreign.failActive({
        sessionID: child,
        error: { type: "foreign.terminal", message: "foreign owner completed with failure" },
      })
      expect(terminalized).toEqual([requestID])
      yield* foreign.signal(terminalized)
      expect(notifications).toEqual([])

      yield* TestClock.adjust("100 millis")
      yield* Effect.yieldNow
      expect(notifications).toHaveLength(1)
      expect(notifications[0]?.data.item).toMatchObject({
        type: "synthetic",
        payload: {
          metadata: { source: "subagent", childID: child, state: "error" },
          text: expect.stringContaining("foreign owner completed with failure"),
        },
      })
      expect(yield* SessionInbox.list(database.db, parent)).toHaveLength(1)
      expect(yield* restarted.pendingBackground).toEqual([])
      expect(yield* attempts(database, child)).toBe(0)
      yield* TestClock.adjust("1 second")
      expect(notifications).toHaveLength(1)
    }),
  )

  it.effect("uses the established visible fallback for an empty recovered continuation terminal", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_continuation_empty_terminal_parent")
      const child = Session.ID.make("ses_continuation_empty_terminal_child")
      const requestID = "sc_recovered_empty_terminal"
      const turnID = "turn_recovered_empty_terminal"
      const notificationID = SessionMessage.ID.make("msg_recovered_empty_terminal_notice")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      yield* database.db
        .insert(SessionSubagentTurnTable)
        .values({
          id: turnID,
          child_session_id: child,
          state: "completed",
          output: "",
          time_terminal: 1,
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionSubagentContinuationTable)
        .values({
          id: requestID,
          parent_session_id: parent,
          parent_message_id: SessionMessage.ID.make("msg_recovery_empty_parent"),
          parent_tool_call_id: "call_recovery_empty",
          child_session_id: child,
          agent: "reviewer",
          description: "Recover empty terminal",
          inbox_id: SessionMessage.ID.make("msg_recovery_empty_inbox"),
          turn_id: turnID,
          state: "completed",
          prompt_digest: "digest",
          time_terminal: 1,
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const waiterID = SessionContinuation.waiterID(requestID)
      yield* jobs.start({
        id: waiterID,
        type: "subagent",
        notificationID,
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "reviewer",
          description: "Recover empty terminal",
          continuationID: requestID,
        },
        run: Effect.never,
      })
      yield* jobs.background(waiterID)

      const parentWoken = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) => (sessionID === parent ? Deferred.succeed(parentWoken, undefined) : Effect.void),
        undefined,
        restarted,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Deferred.await(parentWoken)

      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        {
          payload: {
            text: expect.stringContaining("Subagent completed without a text response."),
            metadata: { source: "subagent", childID: child, state: "completed" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("keeps a bound continuation recoverable until the resumed successor terminalizes it", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_continuation_bound_parent")
      const child = Session.ID.make("ses_continuation_bound_child")
      const requestID = "sc_recovered_bound"
      const turnID = "turn_recovered_bound"
      const notificationID = SessionMessage.ID.make("msg_recovered_bound_notice")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now() })
      yield* database.db
        .insert(SessionSubagentTurnTable)
        .values({
          id: turnID,
          child_session_id: child,
          state: "active",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionSubagentContinuationTable)
        .values({
          id: requestID,
          parent_session_id: parent,
          parent_message_id: SessionMessage.ID.make("msg_recovery_parent"),
          parent_tool_call_id: "call_recovery",
          child_session_id: child,
          agent: "reviewer",
          description: "Recover bound continuation",
          inbox_id: SessionMessage.ID.make("msg_recovery_inbox"),
          turn_id: turnID,
          state: "bound",
          prompt_digest: "digest",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const waiterID = SessionContinuation.waiterID(requestID)
      yield* jobs.start({
        id: waiterID,
        type: "subagent",
        notificationID,
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "reviewer",
          description: "Recover bound continuation",
          continuationID: requestID,
        },
        run: Effect.never,
      })
      yield* jobs.background(waiterID)

      const parentWoken = yield* Deferred.make<void>()
      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) => {
          drained.push(sessionID)
          if (sessionID === child) return Effect.fail(new SessionRunnerModel.ModelNotSelectedError({ sessionID }))
          return Deferred.succeed(parentWoken, undefined)
        },
        undefined,
        restarted,
      )
      const restart = Context.get(context, SessionRestart.Service)
      yield* restart.resumeSuspendedSessions
      yield* Deferred.await(parentWoken)

      expect(drained).toEqual([child, parent])
      expect(
        yield* database.db
          .select()
          .from(SessionSubagentContinuationTable)
          .where(eq(SessionSubagentContinuationTable.id, requestID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "failed" })
      expect(
        yield* database.db
          .select()
          .from(SessionSubagentTurnTable)
          .where(eq(SessionSubagentTurnTable.id, turnID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        state: "failed",
        error: { type: "provider.no-route", message: `No model is available for session ${child}` },
      })
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        {
          payload: {
            text: expect.stringContaining(`No model is available for session ${child}`),
            metadata: { source: "subagent", childID: child, state: "error" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  for (const resumeAttempts of [1, 2]) {
    it.effect(`honors a suspended parent's restart budget after ${resumeAttempts} attempts before notifying it`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const jobs = yield* Job.Service
        const parent = Session.ID.make("ses_subagent_budget_parent")
        const children = [
          Session.ID.make("ses_subagent_budget_child_1"),
          Session.ID.make("ses_subagent_budget_child_2"),
        ]
        yield* seedSessions(database, [parent], { time_suspended: Date.now(), resume_attempts: resumeAttempts })
        yield* seedSessions(database, children, { parent_id: parent })
        const complete = yield* Deferred.make<string>()
        for (const child of children) {
          yield* jobs.start({
            id: child,
            type: "subagent",
            recovery: {
              kind: "subagent",
              parentSessionID: parent,
              childSessionID: child,
              agent: "explore",
              description: "Completed inspection",
            },
            run: Deferred.await(complete),
          })
          yield* jobs.background(child)
        }
        yield* Deferred.succeed(complete, "Recovered result")
        yield* Effect.forEach(children, (id) => jobs.wait({ id }), { discard: true })

        const draining = yield* Deferred.make<number | undefined>()
        const release = yield* Deferred.make<void>()
        const drained: Session.ID[] = []
        const continued: Session.ID[] = []
        yield* bus.project(SessionEvent.Synthetic, (event) =>
          Effect.sync(() => void continued.push(event.data.sessionID)),
        )
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const restarted = yield* Job.make.pipe(Scope.provide(scope))
        const context = yield* buildExecution(
          scope,
          ({ sessionID }) =>
            Effect.gen(function* () {
              drained.push(sessionID)
              yield* Deferred.succeed(draining, yield* attempts(database, sessionID))
              yield* Deferred.await(release)
            }),
          { maxAttempts: 2 },
          restarted,
        )
        const restart = Context.get(context, SessionRestart.Service)
        const execution = Context.get(context, SessionExecution.Service)
        yield* restart.resumeSuspendedSessions

        if (resumeAttempts < 2) {
          expect(yield* Deferred.await(draining)).toBe(2)
          expect(drained).toEqual([parent])
          expect(continued).toEqual([parent])
          yield* Deferred.succeed(release, undefined)
          yield* execution.awaitIdle(parent)
        }
        if (resumeAttempts === 2) {
          expect(drained).toEqual([])
          expect(continued).toEqual([])
        }
        expect((yield* claims(database))[parent]).toBe(false)
        expect(yield* attempts(database, parent)).toBe(0)
        expect(yield* SessionInbox.list(database.db, parent)).toHaveLength(2)
        expect(yield* restarted.pendingBackground).toEqual([])
        yield* restart.resumeSuspendedSessions
        expect(drained).toHaveLength(resumeAttempts < 2 ? 1 : 0)
      }),
    )
  }

  it.effect("terminalizes a recovered subagent that exhausts its resume budget", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_subagent_exhausted_parent")
      const child = Session.ID.make("ses_subagent_exhausted_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now(), resume_attempts: 2 })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Exhausted inspection",
        },
        run: Effect.never,
      })
      yield* jobs.background(child)

      const parentWoken = yield* Deferred.make<void>()
      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(Deferred.succeed(parentWoken, undefined)),
          ),
        { maxAttempts: 2 },
        restarted,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Deferred.await(parentWoken)

      expect(drained).toEqual([parent])
      expect((yield* claims(database))[child]).toBe(false)
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        {
          payload: {
            text: expect.stringContaining("will not be resumed automatically"),
            metadata: { source: "subagent", childID: child, state: "error" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )
})

describe("SessionExecution interrupt continuation", () => {
  it.effect("resumes only steering input after an interrupt with continue", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_continue_steer")
      yield* seedSessions(database, [sessionID])
      yield* seedInbox(database, sessionID, ["steer", "queue"])

      const draining = yield* Deferred.make<void>()
      const drains: Array<{ force: boolean; promotable?: SessionInbox.Promotable }> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.suspend(() => {
          drains.push({ force: input.force, promotable: input.promotable })
          if (drains.length > 1) return Effect.void
          return Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never))
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)

      yield* execution.interrupt(sessionID, { continue: true })
      yield* execution.awaitIdle(sessionID)

      // The successor drain is steer-scoped: queued next-turn work stays parked.
      expect(drains).toEqual([
        { force: true, promotable: "input" },
        { force: false, promotable: "steer" },
      ])
    }),
  )

  it.effect("stays parked after an interrupt with continue when only queued work remains", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_continue_parked")
      yield* seedSessions(database, [sessionID])
      yield* seedInbox(database, sessionID, ["queue"])

      const draining = yield* Deferred.make<void>()
      const drains: Array<SessionInbox.Promotable | undefined> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.suspend(() => {
          drains.push(input.promotable)
          return Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never))
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)

      yield* execution.interrupt(sessionID, { continue: true })
      yield* execution.awaitIdle(sessionID)

      expect(drains).toEqual(["input"])
      expect(yield* execution.active).toEqual(new Set())
    }),
  )

  it.effect("an idle interrupt with continue resumes pending steers", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_continue_idle")
      yield* seedSessions(database, [sessionID])
      yield* seedInbox(database, sessionID, ["steer"])

      const drains: Array<{ force: boolean; promotable?: SessionInbox.Promotable }> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.sync(() => void drains.push({ force: input.force, promotable: input.promotable })),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.interrupt(sessionID, { continue: true })
      yield* execution.awaitIdle(sessionID)

      expect(drains).toEqual([{ force: false, promotable: "steer" }])
    }),
  )

  it.effect("an interrupt with continue resumes a queued compaction next in line", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_continue_compaction")
      yield* seedSessions(database, [sessionID])
      yield* seedInbox(database, sessionID, [{ delivery: "queue", type: "compaction" }])

      const draining = yield* Deferred.make<void>()
      const drains: Array<{ force: boolean; promotable?: SessionInbox.Promotable }> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.suspend(() => {
          drains.push({ force: input.force, promotable: input.promotable })
          if (drains.length > 1) return Effect.void
          return Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never))
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)

      yield* execution.interrupt(sessionID, { continue: true })
      yield* execution.awaitIdle(sessionID)

      // Control work is housekeeping, not next-turn input: continue runs it.
      expect(drains).toEqual([
        { force: true, promotable: "input" },
        { force: false, promotable: "steer" },
      ])
    }),
  )

  it.effect("keeps a control item parked behind a queued prompt on continue", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_continue_control_behind")
      yield* seedSessions(database, [sessionID])
      yield* seedInbox(database, sessionID, ["queue", { delivery: "queue", type: "compaction" }])

      const drains: Array<{ force: boolean; promotable?: SessionInbox.Promotable }> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.sync(() => void drains.push({ force: input.force, promotable: input.promotable })),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.interrupt(sessionID, { continue: true })
      yield* execution.awaitIdle(sessionID)

      // The queued prompt is next in line; the compaction behind it waits its turn.
      expect(drains).toEqual([])
    }),
  )
})

function seedBackground(
  jobs: Job.Interface,
  sessionID: Session.ID,
  background: ReadonlyArray<{ readonly id: string; readonly shellID: string; readonly command: string }>,
) {
  return Effect.forEach(
    background,
    (job) =>
      Effect.gen(function* () {
        yield* jobs.start({
          id: job.id,
          type: "shell",
          recovery: { kind: "shell", sessionID, shellID: job.shellID, command: job.command },
          run: Effect.never,
        })
        yield* jobs.background(job.id)
      }),
    { discard: true },
  )
}

/** Plain deliveries seed user prompts; objects seed control items. */
function seedInbox(
  database: Database.Service["Service"],
  sessionID: Session.ID,
  items: ReadonlyArray<
    SessionInbox.Delivery | { readonly delivery: SessionInbox.Delivery; readonly type: "compaction" }
  >,
) {
  return database.db
    .insert(SessionInboxTable)
    .values(
      items.map((item, index) => {
        const entry = typeof item === "string" ? { delivery: item, type: "user" as const } : item
        return {
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: entry.type,
          payload: entry.type === "user" ? { text: "queued prompt" } : {},
          delivery: entry.delivery,
          enqueued_seq: index + 1,
        }
      }),
    )
    .run()
    .pipe(Effect.orDie)
}

function seedSessions(
  database: Database.Service["Service"],
  sessionIDs: ReadonlyArray<Session.ID>,
  values: Partial<
    Pick<
      typeof SessionTable.$inferInsert,
      | "time_suspended"
      | "resume_attempts"
      | "parent_id"
      | "claim_owner"
      | "claim_pid"
      | "claim_hostname"
      | "claim_updated_at"
      | "claim_expires_at"
    >
  > = {},
) {
  return Effect.gen(function* () {
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values(
        sessionIDs.map((id) => ({
          id,
          project_id: Project.ID.global,
          slug: id,
          directory: "/project",
          title: id,
          version: "test",
          ...values,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

function claims(database: Database.Service["Service"]) {
  return database.db
    .select({ id: SessionTable.id, claimed: SessionTable.time_suspended })
    .from(SessionTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.id, row.claimed !== null]))),
    )
}

function attempts(database: Database.Service["Service"], sessionID: Session.ID) {
  return database.db
    .select({ attempts: SessionTable.resume_attempts })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.attempts),
    )
}

function durableEvents(database: Database.Service["Service"], sessionID: Session.ID) {
  return database.db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .all()
    .pipe(Effect.orDie)
}

function takeLease(database: Database.Service["Service"], sessionID: Session.ID, owner: string) {
  const now = Date.now()
  return database.db
    .update(SessionTable)
    .set({
      claim_owner: owner,
      claim_pid: 99,
      claim_hostname: "takeover-host",
      claim_updated_at: now,
      claim_expires_at: now + 60_000,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}

function lease(database: Database.Service["Service"], sessionID: Session.ID) {
  return database.db
    .select({
      owner: SessionTable.claim_owner,
      expires: SessionTable.claim_expires_at,
      attempts: SessionTable.resume_attempts,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
}

/** Builds the local execution layer plus the restart actions against the test harness services. */
function buildExecution(
  scope: Scope.Closeable,
  drain: (input: Parameters<SessionRunner.Interface["drain"]>[0]) => Effect.Effect<void, SessionRunner.RunError>,
  options?: SessionRestart.Options,
  overrideJobs?: Job.Interface,
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const jobs = overrideJobs ?? (yield* Job.Service)
    const sessions = yield* Session.Service
    const sessionLayer = Layer.effect(
      Session.Service,
      Effect.gen(function* () {
        const execution = yield* SessionExecution.Service
        return Session.Service.of({
          ...sessions,
          synthetic: (input) =>
            sessions
              .synthetic({ ...input, resume: false })
              .pipe(Effect.tap(() => (input.resume === false ? Effect.void : execution.wake(input.sessionID)))),
        })
      }),
    )
    const runner = Layer.succeed(
      SessionRunner.Service,
      SessionRunner.Service.of({
        drain: (input) => drain(input).pipe(Effect.as(SessionRunner.DrainResult.Complete())),
      }),
    )
    const locations = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(
        () =>
          // The local execution test only needs the Session runner from the Location graph.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          runner as unknown as Layer.Layer<LocationServices>,
        ),
    )
    const instances = Layer.effect(
      Instance.Service,
      Effect.map(LocationServiceMap.Service, (locations) =>
        Instance.Service.of({
          provide: (session) => Effect.provide(locations.get(session.location).pipe(Layer.orDie)),
        }),
      ),
    )
    return yield* Layer.buildWithScope(
      SessionRestart.layer(options).pipe(
        Layer.provideMerge(sessionLayer),
        Layer.provideMerge(Layer.fresh(SessionExecution.layer).pipe(Layer.provideMerge(instances))),
        Layer.provideMerge(Layer.fresh(SessionContinuation.layer)),
        Layer.provide(Layer.succeed(Database.Service, database)),
        Layer.provide(Layer.succeed(Bus.Service, bus)),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(Layer.succeed(Job.Service, jobs)),
        Layer.provide(locations),
      ),
      scope,
    )
  })
}
