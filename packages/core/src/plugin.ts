export * as Plugin from "./plugin.js"
export { Event, ID, Info, Source } from "@opencode-ai/schema/plugin"

import { Plugin } from "@opencode-ai/schema/plugin"
import type { Plugin as PluginDefinition } from "@opencode-ai/plugin/effect/plugin"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { App } from "./app.js"
import { Cause, Context, Effect, Exit, Layer, Logger, Queue, References, Scope, Semaphore } from "effect"
import { Agent } from "./agent.js"
import { AISDK } from "./aisdk.js"
import { Catalog } from "./catalog.js"
import { Command } from "./command.js"
import { Bus } from "./bus.js"
import { Integration } from "./integration.js"
import { KV } from "./kv.js"
import { Mcp } from "./mcp/index.js"
import { Location } from "./location.js"
import { PluginHost } from "./plugin/host.js"
import { PluginRuntime } from "./plugin/runtime.js"
import { WebSearch } from "./websearch.js"
import { Reference } from "./reference.js"
import { Rpc } from "./rpc.js"
import { Skill } from "./skill.js"
import { State } from "./state.js"
import { Tool } from "./tool.js"
import { Vcs } from "./vcs.js"
import { PluginHooks } from "./plugin/hooks.js"
import { Generate } from "./generate.js"
import { Permission } from "./permission.js"

export interface Interface {
  readonly activate: (
    plugins: readonly Generation[],
    failures?: readonly Extract<Plugin.Info, { readonly status: "failed" }>[],
  ) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Plugin.Info[]>
}

export type Generation = PluginDefinition & {
  readonly revision: string
  readonly source?: Plugin.Source
  readonly tui?: boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const kv = yield* KV.Service
    const scope = yield* Scope.make()
    // Keep one slot per requested definition, including failed revisions, so prefix comparisons
    // stay index-aligned and unchanged failures are not retried on unrelated refreshes.
    const active = new Map<Plugin.ID, Slot>()
    const lock = Semaphore.makeUnsafe(1)
    const pendingFailures = yield* Queue.unbounded<PendingFailure>()
    let discovered: readonly Extract<Plugin.Info, { readonly status: "failed" }>[] = []
    let closed = false
    let inventory: Plugin.Info[] = []
    let host: Parameters<PluginDefinition["effect"]>[0]
    const load = Effect.fnUntraced(function* (plugin: Generation) {
      const activation: Activation = { plugin, scope: yield* Scope.fork(scope) }
      const inherit = yield* State.inherit()
      const grouped = State.group((failure, refresh) => {
        const ref = `err_${crypto.randomUUID().slice(0, 8)}`
        activation.failure = {
          error: `Plugin disabled after ${failure.state}.transform failed. Check server logs for details (${ref}).`,
          ref,
        }
        Queue.offerUnsafe(pendingFailures, {
          plugin,
          scope: activation.scope,
          failure,
          refresh,
          ref,
        })
      })
      const loaded = yield* Effect.suspend(() =>
        plugin.effect({ ...host, storage: PluginHost.storage(kv, plugin.id) }),
      ).pipe(
        grouped,
        inherit,
        Effect.updateContext((context: Context.Context<never>) =>
          Context.make(Scope.Scope, activation.scope).pipe(
            Context.add(Logger.CurrentLoggers, Context.get(context, Logger.CurrentLoggers)),
            Context.add(References.MinimumLogLevel, Context.get(context, References.MinimumLogLevel)),
          ),
        ),
        Effect.withSpan("Plugin.load", { attributes: { "plugin.id": plugin.id } }),
        Effect.andThen(bus.publish(Plugin.Event.Added, { id: Plugin.ID.make(plugin.id) })),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && !activation.failure ? Scope.close(activation.scope, exit) : Effect.void,
        ),
        Effect.exit,
      )
      if (activation.failure || Exit.isSuccess(loaded)) return { activation } as const
      yield* Effect.logWarning("failed to load plugin", {
        "plugin.id": plugin.id,
        cause: loaded.cause,
      })
      return { error: Cause.pretty(loaded.cause) } as const
    })

    const activate = Effect.fn("Plugin.activate")(function* (
      plugins: readonly Generation[],
      failures: readonly Extract<Plugin.Info, { readonly status: "failed" }>[] = [],
    ) {
      const definitions = plugins.map((plugin) => ({ ...plugin, id: Plugin.ID.make(plugin.id) }))
      const ids = new Set<Plugin.ID>()
      for (const definition of definitions) {
        if (ids.has(definition.id)) yield* Effect.die(new Error(`Duplicate plugin ID: ${definition.id}`))
        ids.add(definition.id)
      }

      yield* lock.withPermit(
        Effect.gen(function* () {
          if (closed) return
          discovered = failures
          const current = Array.from(active.values())
          const changed = definitions.findIndex((definition, index) => {
            const entry = current[index]
            return entry?.plugin.id !== definition.id || entry.plugin.revision !== definition.revision
          })
          const prefix = changed === -1 ? definitions.length : changed
          for (const definition of definitions.slice(0, prefix)) {
            const entry = active.get(definition.id)
            if (entry) active.set(definition.id, { ...entry, plugin: definition })
          }
          if (prefix === definitions.length && active.size === definitions.length) {
            const nextInventory = [...Array.from(active.values()).map(slotInfo), ...failures]
            if (JSON.stringify(inventory) === JSON.stringify(nextInventory)) return
            inventory = nextInventory
            yield* bus.publish(Plugin.Event.Updated, {})
            return
          }

          yield* State.batch(
            Effect.gen(function* () {
              // State registrations are ordered, so only the unchanged prefix can remain alive.
              const previous = new Map(Array.from(active.entries()).slice(prefix))
              yield* Effect.forEach(
                Array.from(previous.entries()).toReversed(),
                ([id, slot]) =>
                  Effect.gen(function* () {
                    active.delete(id)
                    if (slot.activation && !slot.activation.failure)
                      yield* Scope.close(slot.activation.scope, Exit.void).pipe(Effect.ignore)
                  }),
                { discard: true },
              )
              for (const definition of definitions.slice(prefix)) {
                const slot = previous.get(definition.id)
                if (slot?.activation?.failure && slot.plugin.revision === definition.revision) {
                  active.set(definition.id, { ...slot, plugin: definition })
                  continue
                }

                const result = yield* load(definition)
                if (result.activation !== undefined) {
                  active.set(definition.id, { plugin: definition, activation: result.activation })
                  continue
                }
                active.set(definition.id, { plugin: definition, error: result.error })

                const fallback = slot?.activation
                if (!fallback || fallback.failure) continue
                const restored = yield* load(fallback.plugin)
                if (restored.activation !== undefined) {
                  active.set(definition.id, {
                    plugin: definition,
                    activation: restored.activation,
                    error: result.error,
                  })
                  continue
                }
                yield* Effect.logError("failed to restore plugin; deactivating", {
                  "plugin.id": definition.id,
                })
              }

              inventory = [...Array.from(active.values()).map(slotInfo), ...failures]
            }),
          )
          yield* bus.publish(Plugin.Event.Updated, {})
        }),
      )
    })

    yield* Queue.take(pendingFailures).pipe(
      Effect.flatMap((item) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("disabled plugin after transform failure", {
            "plugin.id": item.plugin.id,
            state: item.failure.state,
            ref: item.ref,
            cause: item.failure.cause,
          })
          yield* lock.withPermit(
            Effect.gen(function* () {
              if (closed) return
              inventory = [...Array.from(active.values()).map(slotInfo), ...discovered]
              const refreshed = yield* State.batch(item.refresh).pipe(Effect.exit)
              yield* bus.publish(Plugin.Event.Updated, {})
              if (Exit.isFailure(refreshed))
                yield* Effect.logWarning("failed to refresh state after disabling plugin", {
                  "plugin.id": item.plugin.id,
                  ref: item.ref,
                  cause: refreshed.cause,
                })
            }),
          )
        }).pipe(
          Effect.ensuring(
            Scope.close(item.scope, Exit.void).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to clean up disabled plugin", {
                  "plugin.id": item.plugin.id,
                  ref: item.ref,
                  cause,
                }),
              ),
              Effect.forkScoped({ startImmediately: true }),
            ),
          ),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logError("failed to report disabled plugin", {
                "plugin.id": item.plugin.id,
                ref: item.ref,
                cause,
              }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    )

    yield* Effect.addFinalizer((exit) =>
      lock.withPermit(
        Effect.gen(function* () {
          closed = true
          active.clear()
          yield* State.batch(Scope.close(scope, exit), { flush: false })
        }),
      ),
    )

    const service = Service.of({
      activate,
      list: Effect.fn("Plugin.list")(function* () {
        return inventory
      }),
    })
    host = yield* PluginHost.make(service)
    return service
  }),
)

type Activation = {
  readonly plugin: Generation
  readonly scope: Scope.Closeable
  failure?: { readonly error: string; readonly ref: string }
}

type Slot = {
  readonly plugin: Generation
  readonly activation?: Activation
  readonly error?: string
}

type PendingFailure = {
  readonly plugin: Generation
  readonly scope: Scope.Closeable
  readonly failure: State.Failure
  readonly refresh: Effect.Effect<void>
  readonly ref: string
}

function slotInfo(slot: Slot): Plugin.Info {
  const error = slot.activation?.failure?.error ?? slot.error
  if (error !== undefined) {
    return {
      id: Plugin.ID.make(slot.plugin.id),
      source: slot.plugin.source ?? { type: "builtin" },
      status: "failed",
      error,
      tui: slot.plugin.tui ?? false,
    }
  }
  return activeInfo(slot.plugin)
}

function activeInfo(plugin: Generation): Plugin.Info {
  return {
    id: Plugin.ID.make(plugin.id),
    source: plugin.source ?? { type: "builtin" },
    status: "active",
    tui: plugin.tui ?? false,
  }
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    App.node,
    Agent.node,
    AISDK.node,
    Catalog.node,
    Command.node,
    Integration.node,
    KV.node,
    Mcp.node,
    Location.node,
    Reference.node,
    Rpc.node,
    Skill.node,
    Tool.node,
    Vcs.node,
    PluginHooks.node,
    PluginRuntime.node,
    WebSearch.node,
    Generate.node,
    Permission.node,
  ],
})
