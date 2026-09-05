import { describe, expect } from "bun:test"
import path from "path"
import { mkdir, rm } from "fs/promises"
import { Effect, Layer, LayerMap } from "effect"
import { Worktree } from "@opencode-ai/schema/worktree"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMove } from "@opencode-ai/core/session/move"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { globalProjectLayer } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, SessionMove.node, Session.node]),
    [
      [Project.node, globalProjectLayer],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const foreignExecution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    claim: () => Effect.succeed(false),
    resume: () => Effect.void,
    resumeClaimed: () => Effect.void,
    wake: () => Effect.succeed({ type: "foreign" as const }),
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
const itWithForeignLease = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, SessionMove.node, Session.node]),
    [
      [Project.node, globalProjectLayer],
      [SessionExecution.node, foreignExecution],
    ],
  ),
)
const activeSessionID = Session.ID.make("ses_move_active")
const activeExecution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set([activeSessionID])),
    claim: () => Effect.succeed(true),
    resume: () => Effect.void,
    resumeClaimed: () => Effect.void,
    wake: () => Effect.succeed({ type: "owned" as const }),
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
const itWithActiveLease = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, SessionMove.node, Session.node]),
    [
      [Project.node, globalProjectLayer],
      [SessionExecution.node, activeExecution],
    ],
  ),
)
const unavailableLocations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () => Layer.effectDiscard(Effect.fail(new Error("broken location"))) as unknown as Layer.Layer<LocationServices>,
  ),
)
const itWithUnavailableDestination = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      [Project.node, globalProjectLayer],
      [SessionExecution.node, SessionExecution.noopLayer],
      [LocationServiceMap.node, unavailableLocations],
    ],
  ),
)

describe("Session.move", () => {
  it.effect("moves through the bound service without depending on the Session facade", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const moves = yield* SessionMove.Service
          const source = AbsolutePath.make(path.join(tmp.path, "missing"))
          const destination = AbsolutePath.make(tmp.path)
          const created = yield* sessions.create({ location: Location.Ref.make({ directory: source }) })

          yield* moves.move({ sessionID: created.id, directory: destination })

          expect((yield* sessions.get(created.id)).location.directory).toBe(destination)
        }),
      ),
    ),
  )

  it.effect("recovers an idle move after the selected source instance fails to initialize", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const source = AbsolutePath.make(path.join(tmp.path, "source"))
          const destination = AbsolutePath.make(path.join(tmp.path, "destination"))
          yield* Effect.promise(() => Promise.all([mkdir(source), mkdir(destination)]))
          yield* Effect.promise(() =>
            Bun.write(path.join(source, "opencode.json"), JSON.stringify({ instructions: ["{file:./missing.txt}"] })),
          )
          const created = yield* sessions.create({ location: Location.Ref.make({ directory: source }) })

          yield* sessions.move({ sessionID: created.id, directory: destination })

          expect((yield* sessions.get(created.id)).location.directory).toBe(destination)
          expect(yield* sessions.inbox(created.id)).toEqual([])
        }),
      ),
    ),
  )

  itWithForeignLease.effect("does not probe or recover a selected source instance behind a foreign lease", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const source = AbsolutePath.make(path.join(tmp.path, "source"))
          const destination = AbsolutePath.make(path.join(tmp.path, "destination"))
          yield* Effect.promise(() => Promise.all([mkdir(source), mkdir(destination)]))
          yield* Effect.promise(() =>
            Bun.write(path.join(source, "opencode.json"), JSON.stringify({ instructions: ["{file:./missing.txt}"] })),
          )
          const created = yield* sessions.create({ location: Location.Ref.make({ directory: source }) })

          yield* sessions.move({ sessionID: created.id, directory: destination })

          expect((yield* sessions.get(created.id)).location.directory).toBe(source)
          expect(yield* sessions.inbox(created.id)).toMatchObject([
            { type: "move", payload: { location: { directory: destination } } },
          ])
        }),
      ),
    ),
  )

  itWithActiveLease.effect("defers an active move even when its source directory is missing", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const source = AbsolutePath.make(path.join(tmp.path, "missing"))
          const destination = AbsolutePath.make(tmp.path)
          yield* sessions.create({ id: activeSessionID, location: Location.Ref.make({ directory: source }) })

          yield* sessions.move({ sessionID: activeSessionID, directory: destination })

          expect((yield* sessions.get(activeSessionID)).location.directory).toBe(source)
          expect(yield* sessions.inbox(activeSessionID)).toMatchObject([
            { type: "move", payload: { location: { directory: destination } } },
          ])
        }),
      ),
    ),
  )

  itWithUnavailableDestination.effect("rejects an unavailable destination before admitting the move", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const source = AbsolutePath.make(path.join(tmp.path, "source"))
          const destination = AbsolutePath.make(path.join(tmp.path, "destination"))
          yield* Effect.promise(() => Promise.all([mkdir(source), mkdir(destination)]))
          const created = yield* session.create({ location: Location.Ref.make({ directory: source }) })

          const error = yield* session.move({ sessionID: created.id, directory: destination }).pipe(Effect.flip)

          expect(error).toEqual(new Session.DestinationUnavailableError({ directory: destination }))
          expect((yield* session.get(created.id)).location.directory).toBe(source)
          expect(yield* session.inbox(created.id)).toEqual([])
        }),
      ),
    ),
  )

  it.effect("applies a move immediately when the source directory no longer exists", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const destination = AbsolutePath.make(tmp.path)
          const source = path.join(tmp.path, "source")
          yield* Effect.promise(() => mkdir(source))
          const created = yield* session.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(source) }),
          })

          yield* session.move({ sessionID: created.id, directory: destination })
          expect((yield* session.get(created.id)).location.directory).toBe(AbsolutePath.make(source))
          expect(yield* session.inbox(created.id)).toHaveLength(1)
          const pending = yield* session.synthetic({
            sessionID: created.id,
            text: "Keep queued",
            delivery: "queue",
            resume: false,
          })
          yield* session.move({ sessionID: created.id, directory: destination, delivery: "queue" })
          expect(yield* session.inbox(created.id)).toHaveLength(3)

          yield* Effect.promise(() => rm(source, { recursive: true }))
          yield* session.move({ sessionID: created.id, directory: destination })

          expect((yield* session.get(created.id)).location.directory).toBe(destination)
          expect(yield* session.inbox(created.id)).toEqual([pending])

          yield* session.move({ sessionID: created.id, directory: destination })
          expect(yield* session.inbox(created.id)).toHaveLength(2)

          yield* Effect.promise(() => mkdir(path.join(tmp.path, "other")))
          const steered = yield* session.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(path.join(tmp.path, "other")) }),
          })
          yield* session.move({ sessionID: steered.id, directory: destination, delivery: "queue" })
          expect(yield* session.inbox(steered.id)).toMatchObject([{ type: "move", delivery: "queue" }])
        }),
      ),
    ),
  )

  it.effect("keeps a moved session out of its former directory's new identity", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const bus = yield* Bus.Service
          const previous = AbsolutePath.make(path.join(tmp.path, "previous"))
          const destination = AbsolutePath.make(tmp.path)
          const created = yield* session.create({ location: Location.Ref.make({ directory: previous }) })

          // Moves are admitted through the inbox and applied by the drain;
          // publish the applied move directly since execution is a no-op here.
          yield* bus.publish(SessionEvent.Moved, {
            sessionID: created.id,
            location: Location.Ref.make({ directory: destination }),
            projectID: Project.ID.global,
          })
          // The former directory becomes a project after the session left it.
          yield* bus.publish(Worktree.Event.Resolved, {
            projectID: Project.ID.make("adopting"),
            directory: previous,
            previous: Project.ID.global,
          })

          expect(yield* session.get(created.id)).toMatchObject({
            projectID: Project.ID.global,
            location: { directory: destination },
            subpath: undefined,
          })
        }),
      ),
    ),
  )
})
