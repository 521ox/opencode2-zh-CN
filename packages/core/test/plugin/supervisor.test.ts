import { describe, expect } from "bun:test"
import { Deferred, Duration, Effect, Layer, LayerMap, Stream } from "effect"
import { TestClock } from "effect/testing"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { Command } from "@opencode-ai/core/command"
import { ConfigPluginSource } from "@opencode-ai/core/config/plugin/source"
import { Instance } from "@opencode-ai/core/instance"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "../../src/database/database"
import { Bus } from "../../src/bus"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdir } from "../fixture/tmpdir"
import { advance } from "../lib/clock"
import { testEffect } from "../lib/effect"

const id = Plugin.ID.make("account-prompts")

// Host and instance plugins share one ID; each registers a distinct command so the winner is observable.
const greeter = (command: string, plugin: string = id) =>
  define({
    id: plugin,
    effect: (ctx) =>
      ctx.command.transform((editor) => editor.add({ name: command, execute: () => Effect.void })).pipe(Effect.asVoid),
  })

// Generation zero performs one Supervisor scan plus one SkillPlugin diagnostic scan.
// The unchanged SkillPlugin is retained on later generations, so each later generation
// adds only its Supervisor scan. Subtract the one-time diagnostic lookup from raw progress.
const source = {
  lookups: 0,
  reset() {
    source.lookups = 0
  },
  generations() {
    if (source.lookups < 2) throw new Error(`Initial config source scans are incomplete: ${source.lookups}`)
    return source.lookups - 1
  },
}
const sourceLayer = Layer.succeed(
  ConfigPluginSource.Service,
  ConfigPluginSource.Service.of({
    operations: () =>
      Effect.sync(() => {
        source.lookups++
        return []
      }),
    changes: () => Stream.never,
  }),
)

const instances = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const map = yield* LayerMap.make(
      (ref: Location.Ref) =>
        Instance.layer(ref, { discovery: false, plugins: [greeter("instance-greet")], replacements: bindings }),
      { idleTimeToLive: Duration.infinity },
    )
    const bindings: LayerNode.Replacements = [
      [Global.node, tempGlobalLayer],
      offlineModels,
      [ConfigPluginSource.node, sourceLayer],
      [LocationServiceMap.node, Layer.succeed(LocationServiceMap.Service, map)],
      [Instance.node,
        Layer.succeed(Instance.Service, {
          provide: (session) => Effect.provide(map.get(session.location).pipe(Layer.orDie)),
        }),
      ],
    ]
    return map
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]), [
    [Global.node, tempGlobalLayer],
    offlineModels,
    [LocationServiceMap.node, instances],
  ]),
)

describe("PluginSupervisor", () => {
  it.live("reports a duplicate plugin ID as a failure without dropping the generation", () =>
    Effect.gen(function* () {
      const sdk = yield* SdkPlugins.Service
      yield* sdk.register(greeter("host-greet"))
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const locations = yield* LocationServiceMap.Service
      const state = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* PluginSupervisor.Service.use((supervisor) => supervisor.awaitActivation)
        const commands = yield* Command.Service
        return {
          inventory: yield* plugins.list(),
          host: yield* commands.get("host-greet"),
          instance: yield* commands.get("instance-greet"),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )

      // Earlier boot order wins: the host SDK plugin activates and the instance copy is reported.
      expect(state.inventory.filter((plugin) => plugin.id === id)).toEqual([
        { id, source: { type: "sdk" }, status: "active", tui: false },
        {
          id,
          source: { type: "sdk" },
          status: "failed",
          error: `Duplicate plugin ID: ${id}`,
          tui: false,
        },
      ])
      expect(state.host).toBeDefined()
      expect(state.instance).toBeUndefined()
      // Builtins stay active: the duplicate is a plugin failure, not a generation defect.
      expect(
        state.inventory.some((plugin) => plugin.id?.startsWith("opencode.") && plugin.status === "active"),
      ).toBe(true)
    }),
  )

  it.effect("activates the initial generation without waiting for the reload debounce", () =>
    Effect.gen(function* () {
      source.reset()
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        // The TestClock never advances here, so any timer between boot and the first activation would hang this.
        yield* PluginSupervisor.Service.use((supervisor) => supervisor.awaitActivation)
        expect(yield* commands.get("instance-greet")).toBeDefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(source.generations()).toBe(1)
    }),
  )

  it.effect("refreshes every 24 hours without adding an immediate reload", () =>
    Effect.gen(function* () {
      source.reset()
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* PluginSupervisor.Service.use((supervisor) => supervisor.awaitActivation)
        yield* TestClock.adjust("23 hours")
        expect(source.generations()).toBe(1)

        yield* TestClock.adjust("1 hour")
        yield* advance(() => source.lookups === 3)
        yield* PluginSupervisor.Service.use((supervisor) => supervisor.awaitActivation)

        yield* TestClock.adjust("24 hours")
        yield* advance(() => source.lookups === 4)
        yield* PluginSupervisor.Service.use((supervisor) => supervisor.awaitActivation)
        expect(source.generations()).toBe(3)
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )

  it.effect("reloads for a trigger published while the initial generation is activating", () =>
    Effect.gen(function* () {
      source.reset()
      const sdk = yield* SdkPlugins.Service
      const entered = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      yield* sdk.register(
        define({
          id: "gated",
          effect: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        }),
      )
      let late = false
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* Deferred.await(entered)
        // Generation 0 is mid-setup: the reload feed must already be subscribed for this update to count.
        yield* sdk.register(
          define({
            id: "late",
            effect: (ctx) =>
              ctx.command
                .transform((editor) => editor.add({ name: "late-greet", execute: () => Effect.void }))
                .pipe(Effect.tap(() => Effect.sync(() => (late = true)))),
          }),
        )
        yield* Deferred.succeed(gate, undefined)
        yield* advance(() => late)
        yield* PluginSupervisor.Service.use((supervisor) => supervisor.awaitActivation)
        expect(yield* commands.get("late-greet")).toBeDefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(source.generations()).toBe(2)
    }),
  )

  it.effect("coalesces a burst of reload triggers after the initial generation into one activation", () =>
    Effect.gen(function* () {
      source.reset()
      const sdk = yield* SdkPlugins.Service
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* PluginSupervisor.Service.use((supervisor) => supervisor.awaitActivation)
        expect(source.generations()).toBe(1)

        yield* sdk.register(greeter("greet-a", "a"))
        yield* sdk.register(greeter("greet-b", "b"))
        yield* sdk.register(greeter("greet-c", "c"))
        yield* advance(() => source.lookups === 3)
        yield* PluginSupervisor.Service.use((supervisor) => supervisor.awaitActivation)
        expect(yield* commands.get("greet-a")).toBeDefined()
        expect(yield* commands.get("greet-c")).toBeDefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(source.generations()).toBe(2)
    }),
  )
})
