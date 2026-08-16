import { Database as BunDatabase } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIError, TransportReason } from "@opencode-ai/ai"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Bus } from "@opencode-ai/core/bus"
import { EventTable } from "@opencode-ai/core/event/sql"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRestart } from "@opencode-ai/core/session/execution/restart"
import { UserInterruptedError } from "@opencode-ai/core/session/error"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionRunner } from "@opencode-ai/core/session/runner/index"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Context, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Scope } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionStore.node])))
const testOwner: SessionStore.Owner = { id: "test-owner", pid: 0, hostname: "test", leaseMs: 30_000 }

describe("SessionExecution lifecycle", () => {
  test("classifies success and typed failure terminals", () => {
    expect(SessionExecution.terminal(Exit.succeed(undefined))).toEqual({ type: "succeeded" })
    expect(
      SessionExecution.terminal(
        Exit.fail(
          new AIError({
            module: "test",
            method: "stream",
            reason: new TransportReason({ message: "Disconnected", transport: "http", operation: "request" }),
          }),
        ),
      ),
    ).toEqual({ type: "failed", error: { type: "provider.transport", message: "Disconnected" } })
  })

  test("defaults owner-scope interruption to shutdown and preserves explicit reasons", () => {
    const interrupted = Effect.runSyncExit(Effect.interrupt)
    expect(SessionExecution.terminal(interrupted)).toEqual({ type: "interrupted", reason: "shutdown" })
    expect(SessionExecution.terminal(interrupted, "user")).toEqual({ type: "interrupted", reason: "user" })
    expect(SessionExecution.terminal(interrupted, "superseded")).toEqual({ type: "interrupted", reason: "superseded" })
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
      // An orphaned child is never resumed: the resumed parent re-runs its
      // tool call and spawns a fresh child instead.
      yield* seedSessions(database, [child], { time_suspended: Date.now(), parent_id: parent })

      expect(yield* store.listSuspended()).toEqual([parent])

      // The sweep clears orphaned child claims outright; parents keep theirs.
      yield* store.releaseChildClaims(testOwner)
      expect(yield* claims(database)).toEqual({ [parent]: true, [child]: false, [idle]: false })
    }),
  )

  it.effect("claims at execution start, releases on completion, and preserves through teardown", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const interrupted = Session.ID.make("ses_claim_interrupted")
      const completed = Session.ID.make("ses_claim_completed")
      yield* seedSessions(database, [interrupted, completed])

      // Each drain signals once it runs; the claim commits before the drain starts.
      const interruptedRunning = yield* Deferred.make<void>()
      const completedRunning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        sessionID === completed
          ? Deferred.succeed(completedRunning, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Deferred.succeed(interruptedRunning, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
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

      // Graceful teardown preserves suspended state but expires the lease so the
      // next server can take ownership immediately.
      yield* Scope.close(scope, Exit.void)
      expect((yield* claims(database))[interrupted]).toBe(true)
      expect(yield* lease(database, interrupted)).toMatchObject({ owner: execution.owner.id })
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

      yield* execution.interrupt(sessionID)
      yield* execution.awaitIdle(sessionID)
      expect((yield* claims(database))[sessionID]).toBe(false)
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

      yield* store.releaseChildClaims(testOwner)
      expect(yield* lease(database, childID)).toMatchObject({ owner: testOwner.id })

      yield* database.db
        .update(SessionTable)
        .set({ claim_expires_at: Date.now() - 1 })
        .where(eq(SessionTable.id, childID))
        .run()
        .pipe(Effect.orDie)
      yield* store.releaseChildClaims(testOwner)
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

      yield* database.db
        .update(SessionTable)
        .set({
          claim_owner: "foreign-owner",
          claim_pid: 99,
          claim_hostname: "foreign-host",
          claim_updated_at: Date.now(),
          claim_expires_at: Date.now() + 60_000,
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
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
  const database = new BunDatabase(databasePath)
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
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const runner = Layer.succeed(
      SessionRunner.Service,
      SessionRunner.Service.of({ drain: (input) => drain(input).pipe(Effect.as({ type: "complete" as const })) }),
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
    return yield* Layer.buildWithScope(
      SessionRestart.layer(options).pipe(
        Layer.provideMerge(SessionExecution.layer),
        Layer.provide(Layer.succeed(Database.Service, database)),
        Layer.provide(Layer.succeed(Bus.Service, bus)),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(locations),
      ),
      scope,
    )
  })
}
