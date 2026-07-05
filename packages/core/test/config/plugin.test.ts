import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { define } from "@opencode-ai/plugin/v2/effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect } from "effect"
import { Database } from "../../src/database/database"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SdkPlugins.node, LocationServiceMap.node])),
)

describe("PluginSupervisor config", () => {
  it.live("applies selectors in order", () =>
    withLocation(
      { plugins: ["-opencode.provider.*", "opencode.provider.openai"] },
      Effect.gen(function* () {
        const plugins = yield* PluginV2.Service
        yield* ready()
        expect(
          (yield* plugins.list()).map((plugin) => plugin.id).filter((id) => id.startsWith("opencode.provider.")),
        ).toEqual([PluginV2.ID.make("opencode.provider.openai")])
      }),
    ),
  )

  it.live("loads configured Promise plugins with options", () =>
    withLocation(
      {
        plugins: [
          "-*",
          {
            package: path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts"),
            options: { description: "Loaded from config" },
          },
        ],
      },
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        expect(yield* agents.get(AgentV2.ID.make("configured"))).toMatchObject({
          description: "Loaded from config",
          mode: "subagent",
        })
      }),
    ),
  )

  it.live("loads configured Effect plugins with options", () =>
    withLocation(
      {
        plugins: [
          "-*",
          {
            package: path.join(import.meta.dir, "../plugin/fixtures/config-effect-plugin.ts"),
            options: { description: "Effect plugin from config" },
          },
        ],
      },
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        expect(yield* agents.get(AgentV2.ID.make("effect-configured"))).toMatchObject({
          description: "Effect plugin from config",
          mode: "subagent",
        })
      }),
    ),
  )

  it.live("ignores invalid packages and continues loading", () =>
    withLocation(
      {
        plugins: [
          "-*",
          path.join(import.meta.dir, "../plugin/fixtures/missing-plugin.ts"),
          path.join(import.meta.dir, "../plugin/fixtures/invalid-plugin.ts"),
          {
            package: path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts"),
            options: { description: "Loaded after invalid plugins" },
          },
        ],
      },
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        expect(yield* agents.get(AgentV2.ID.make("configured"))).toMatchObject({
          description: "Loaded after invalid plugins",
        })
      }),
    ),
  )

  it.live("loads auto-discovered plugin files and packages", () =>
    withLocation(
      undefined,
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        expect(yield* agents.get(AgentV2.ID.make("directory"))).toMatchObject({
          description: "Loaded from plugin directory",
        })
        expect(yield* agents.get(AgentV2.ID.make("folder"))).toMatchObject({
          description: "Loaded from plugin folder",
        })
      }),
      true,
    ),
  )

  it.live("applies explicit removals after auto-discovery", () =>
    withLocation(
      { plugins: ["-*"] },
      Effect.gen(function* () {
        yield* ready()
        const agents = yield* AgentV2.Service
        expect(yield* agents.get(AgentV2.ID.make("directory"))).toBeUndefined()
        expect(yield* agents.get(AgentV2.ID.make("folder"))).toBeUndefined()
      }),
      true,
    ),
  )

  it.live("loads user plugins before internal post plugins", () =>
    Effect.gen(function* () {
      const sdk = yield* SdkPlugins.Service
      yield* sdk.register(define({ id: "sdk-order", effect: () => Effect.void }))
      yield* withLocation(
        {
          plugins: [
            path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts"),
            path.join(import.meta.dir, "../plugin/fixtures/variant-source-plugin.ts"),
          ],
        },
        Effect.gen(function* () {
          yield* ready()
          const registry = yield* PluginV2.Service
          const ids = (yield* registry.list()).map((plugin) => String(plugin.id))
          expect(ids.indexOf("opencode.agent")).toBeLessThan(ids.indexOf("sdk-order"))
          expect(ids.indexOf("sdk-order")).toBeLessThan(ids.indexOf("config-promise-plugin"))
          expect(ids.indexOf("config-promise-plugin")).toBeLessThan(ids.indexOf("variant-source"))
          expect(ids.indexOf("variant-source")).toBeLessThan(ids.indexOf("opencode.config.provider"))
          expect(ids.indexOf("opencode.config.provider")).toBeLessThan(ids.indexOf("opencode.variant"))

          const catalog = yield* Catalog.Service
          expect(
            (yield* catalog.model.get(ProviderV2.ID.make("configured"), ModelV2.ID.make("glm-5.2")))?.variants,
          ).toEqual([
            expect.objectContaining({ id: "high", headers: { custom: "true" } }),
            expect.objectContaining({ id: "max", settings: { reasoningEffort: "max" } }),
          ])
        }),
      )
    }),
  )

  it.live("allows variant generation to be disabled", () =>
    withLocation(
      {
        plugins: [path.join(import.meta.dir, "../plugin/fixtures/variant-source-plugin.ts"), "-opencode.variant"],
      },
      Effect.gen(function* () {
        yield* ready()
        const registry = yield* PluginV2.Service
        expect((yield* registry.list()).map((plugin) => String(plugin.id))).not.toContain("opencode.variant")

        const catalog = yield* Catalog.Service
        expect(
          (yield* catalog.model.get(ProviderV2.ID.make("configured"), ModelV2.ID.make("glm-5.2")))?.variants,
        ).toEqual([expect.objectContaining({ id: "high", headers: { custom: "true" } })])
      }),
    ),
  )
})

const ready = Effect.fnUntraced(function* () {
  const supervisor = yield* PluginSupervisor.Service
  yield* supervisor.ready
})

function withLocation<A, E, R>(config: unknown, effect: Effect.Effect<A, E, R>, fixtures = false) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.tap((tmp) =>
      Effect.promise(async () => {
        if (fixtures) {
          const directory = path.join(tmp.path, ".opencode")
          await fs.mkdir(directory, { recursive: true })
          await Promise.all(
            ["plugin", "plugins"].map((name) =>
              fs.symlink(path.join(import.meta.dir, "fixtures", name), path.join(directory, name), "dir"),
            ),
          )
        }
        if (config !== undefined) {
          const directory = fixtures ? path.join(tmp.path, ".opencode") : tmp.path
          await fs.mkdir(directory, { recursive: true })
          await fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify(config))
        }
      }),
    ),
    Effect.flatMap((tmp) =>
      effect.pipe(
        Effect.scoped,
        Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))),
      ),
    ),
  )
}
