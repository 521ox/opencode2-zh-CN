import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Image } from "@opencode-ai/core/image"
import { Location } from "@opencode-ai/core/location"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { OpenCodeTools } from "@opencode-ai/core/tool/plugin/opencode"
import { Tool } from "@opencode-ai/core/tool"
import { Money } from "@opencode-ai/schema/money"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { imagePassthrough } from "./lib/image"
import { it } from "./lib/effect"
import { registerToolPlugin } from "./lib/tool"

const selected = Location.Ref.make({ directory: AbsolutePath.make("/workspace") })
const other = Location.Ref.make({ directory: AbsolutePath.make("/other") })
const destination = AbsolutePath.make("/destination")
const callerID = Session.ID.make("ses_caller")
const ancestorID = Session.ID.make("ses_ancestor")
const childID = Session.ID.make("ses_child")
const grandchildID = Session.ID.make("ses_grandchild")
const descendantID = Session.ID.make("ses_descendant")
const siblingID = Session.ID.make("ses_sibling")
const foreignParentID = Session.ID.make("ses_foreign_parent")
const foreignChildID = Session.ID.make("ses_foreign_child")
const unownedID = Session.ID.make("ses_unowned")
const crossInstanceID = Session.ID.make("ses_cross_instance")
const missingID = Session.ID.make("ses_missing")

const info = (id: Session.ID, parentID?: Session.ID, location = selected) =>
  Session.Info.make({
    id,
    parentID,
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location,
  })

const openCodeToolNode = makeLocationNode({
  name: "test/opencode-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(OpenCodeTools.Plugin)),
  deps: [Tool.node, PluginRuntime.node],
})

const registrationLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, openCodeToolNode]), [
  [Image.node, imagePassthrough],
])

describe("OpenCodeTools", () => {
  it.effect("registers one pinned session move tool", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const snapshot = yield* registry.snapshot()
      const namespace = snapshot.codeModeCatalog?.tools.find(
        (entry) => entry.type === "namespace" && entry.name === "opencode",
      )
      if (!namespace || namespace.type !== "namespace") return yield* Effect.die("opencode namespace not found")

      expect(namespace.tools).toHaveLength(1)
      expect(namespace.tools[0]).toMatchObject({ type: "tool", name: "session_move", pinned: true })
    }).pipe(Effect.provide(registrationLayer)),
  )

  it.effect("moves the current session and a same-instance direct child", () =>
    Effect.gen(function* () {
      const records = new Map([
        [callerID, info(callerID, ancestorID)],
        [childID, info(childID, callerID)],
      ])
      const calls: Parameters<PluginRuntime.Interface["session"]["move"]>[0][] = []
      const sessions: Pick<PluginRuntime.Interface["session"], "get" | "move"> = {
        get: (sessionID) => {
          const session = records.get(sessionID)
          return session ? Effect.succeed(session) : Effect.fail(new Session.NotFoundError({ sessionID }))
        },
        move: (input) => Effect.sync(() => calls.push(input)),
      }

      expect(yield* OpenCodeTools.move(sessions, selected, { directory: destination }, callerID)).toMatchObject({
        output: { sessionID: callerID, directory: destination },
      })
      expect(
        yield* OpenCodeTools.move(sessions, selected, { sessionID: childID, directory: destination }, callerID),
      ).toMatchObject({ output: { sessionID: childID, directory: destination } })
      expect(calls).toEqual([
        { sessionID: callerID, directory: destination, delivery: "steer" },
        { sessionID: childID, directory: destination, delivery: "steer" },
      ])
    }),
  )

  it.effect("reports the move owner failure without retrying or falling back", () =>
    Effect.gen(function* () {
      const calls: Parameters<PluginRuntime.Interface["session"]["move"]>[0][] = []
      const sessions: Pick<PluginRuntime.Interface["session"], "get" | "move"> = {
        get: () => Effect.succeed(info(callerID, ancestorID)),
        move: (input) =>
          Effect.sync(() => calls.push(input)).pipe(
            Effect.andThen(Effect.fail(new Session.DestinationNotFoundError({ directory: destination }))),
          ),
      }

      const error = yield* OpenCodeTools.move(sessions, selected, { directory: destination }, callerID).pipe(
        Effect.flip,
      )
      expect(error.message).toBe(`Unable to move session to ${destination}`)
      expect(calls).toEqual([{ sessionID: callerID, directory: destination, delivery: "steer" }])
    }),
  )

  it.effect("rejects every non-owned target before the move side effect", () =>
    Effect.gen(function* () {
      const records = new Map([
        [callerID, info(callerID, ancestorID)],
        [ancestorID, info(ancestorID)],
        [childID, info(childID, callerID)],
        [grandchildID, info(grandchildID, childID)],
        [descendantID, info(descendantID, grandchildID)],
        [siblingID, info(siblingID, ancestorID)],
        [foreignChildID, info(foreignChildID, foreignParentID)],
        [unownedID, info(unownedID)],
        [crossInstanceID, info(crossInstanceID, callerID, other)],
      ])
      const calls: Parameters<PluginRuntime.Interface["session"]["move"]>[0][] = []
      const sessions: Pick<PluginRuntime.Interface["session"], "get" | "move"> = {
        get: (sessionID) => {
          const session = records.get(sessionID)
          return session ? Effect.succeed(session) : Effect.fail(new Session.NotFoundError({ sessionID }))
        },
        move: (input) => Effect.sync(() => calls.push(input)),
      }
      const denied = [
        { sessionID: ancestorID, message: "not a direct child" },
        { sessionID: siblingID, message: "not a direct child" },
        { sessionID: grandchildID, message: "not a direct child" },
        { sessionID: descendantID, message: "not a direct child" },
        { sessionID: foreignChildID, message: "not a direct child" },
        { sessionID: unownedID, message: "not a direct child" },
        { sessionID: crossInstanceID, message: "selected instance" },
        { sessionID: missingID, message: "Target session not found" },
      ]

      for (const scenario of denied) {
        const error = yield* OpenCodeTools.move(
          sessions,
          selected,
          { sessionID: scenario.sessionID, directory: destination },
          callerID,
        ).pipe(Effect.flip)
        expect(error.message).toContain(scenario.message)
      }
      expect(calls).toEqual([])
    }),
  )

  it.effect("rejects a missing or cross-instance caller before the move side effect", () =>
    Effect.gen(function* () {
      const calls: Parameters<PluginRuntime.Interface["session"]["move"]>[0][] = []
      const move = (input: Parameters<PluginRuntime.Interface["session"]["move"]>[0]) =>
        Effect.sync(() => calls.push(input))
      const missing: Pick<PluginRuntime.Interface["session"], "get" | "move"> = {
        get: (sessionID) => Effect.fail(new Session.NotFoundError({ sessionID })),
        move,
      }
      const misplaced: Pick<PluginRuntime.Interface["session"], "get" | "move"> = {
        get: () => Effect.succeed(info(callerID, ancestorID, other)),
        move,
      }

      expect(
        (yield* OpenCodeTools.move(missing, selected, { directory: destination }, callerID).pipe(Effect.flip)).message,
      ).toContain("Calling session not found")
      expect(
        (yield* OpenCodeTools.move(misplaced, selected, { directory: destination }, callerID).pipe(Effect.flip))
          .message,
      ).toContain("selected instance")
      expect(calls).toEqual([])
    }),
  )
})
