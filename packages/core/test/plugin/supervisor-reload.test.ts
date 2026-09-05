import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { expect, setDefaultTimeout } from "bun:test"
import { Effect } from "effect"
import { Event } from "@opencode-ai/schema/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { Bus } from "@opencode-ai/core/bus"
import { Command } from "@opencode-ai/core/command"
import { Database } from "@opencode-ai/core/database/database"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Plugin } from "@opencode-ai/core/plugin"
import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

setDefaultTimeout(15_000)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]), [
    [Global.node, tempGlobalLayer],
    offlineModels,
  ]),
)

const pluginApi = pathToFileURL(path.join(import.meta.dir, "../../../plugin/src/promise/index.ts")).href
const greeter = `import { Plugin } from ${JSON.stringify(pluginApi)}

export default Plugin.define({
  id: "greeter",
  setup: async (ctx) => {
    await ctx.command.transform((draft) => draft.add({ name: "greet-v1", execute: async () => {} }))
  },
})`

it.live("keeps the running generation when an updated local plugin fails to import", () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.tap((tmp) =>
      Effect.promise(async () => {
        const file = path.join(tmp.path, ".opencode/plugins/greeter.ts")
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, greeter)
        const before = new Date(Date.now() - 60_000)
        await fs.utimes(file, before, before)
      }),
    ),
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const supervisor = yield* PluginSupervisor.Service
        const commands = yield* Command.Service
        const bus = yield* Bus.Service
        yield* supervisor.awaitActivation
        expect(yield* commands.get("greet-v1")).toBeDefined()

        const file = path.join(tmp.path, ".opencode/plugins/greeter.ts")
        yield* Effect.promise(async () => {
          await fs.writeFile(file, "export default {")
          const updated = new Date()
          await fs.utimes(file, updated, updated)
        })
        yield* bus.publish(Event.Updated, {})
        yield* supervisor.awaitActivation

        expect(yield* commands.get("greet-v1")).toBeDefined()
        expect(yield* plugins.list()).toContainEqual(
          expect.objectContaining({
            id: Plugin.ID.make("greeter"),
            source: { type: "local", path: file },
            status: "active",
          }),
        )
        expect(yield* plugins.list()).toContainEqual(
          expect.objectContaining({ source: { type: "local", path: file }, status: "failed" }),
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))),
      ),
    ),
  ),
)
