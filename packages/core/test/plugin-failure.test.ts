import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { Command } from "@opencode-ai/core/command"
import { Integration } from "@opencode-ai/core/integration"
import { Plugin } from "@opencode-ai/core/plugin"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const waitForFailure = (plugins: Plugin.Interface, attempts = 100): Effect.Effect<Plugin.Info, string> =>
  Effect.gen(function* () {
    const entry = (yield* plugins.list()).find((plugin) => plugin.id === "broken")
    if (entry?.status === "failed") return entry
    if (attempts === 0) return yield* Effect.fail("plugin failure was not reported")
    yield* Effect.yieldNow
    return yield* waitForFailure(plugins, attempts - 1)
  })

it.effect("removes every failed plugin transform without affecting healthy plugins", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const agents = yield* Agent.Service
    const commands = yield* Command.Service
    const integrations = yield* Integration.Service
    let fail = false
    yield* plugins.activate([
      {
        id: "broken",
        revision: "1",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.integration.transform((draft) => draft.update("broken", (entry) => (entry.name = "Broken")))
            yield* ctx.agent.transform((draft) => {
              draft.update("broken", (agent) => {
                agent.description = "partial"
              })
              if (fail) throw new Error("replay failed")
            })
          }),
      },
      {
        id: "healthy",
        revision: "1",
        effect: (ctx) =>
          ctx.command
            .transform((draft) => draft.add({ name: "healthy", execute: () => Effect.void }))
            .pipe(Effect.asVoid),
      },
    ])

    fail = true
    yield* agents.reload()
    const failure = yield* waitForFailure(plugins)
    expect(failure).toMatchObject({ status: "failed", tui: false })
    expect(yield* agents.get(Agent.ID.make("broken"))).toBeUndefined()
    expect(yield* integrations.get(Integration.ID.make("broken"))).toBeUndefined()
    expect(yield* commands.get("healthy")).toBeDefined()
  }),
)
