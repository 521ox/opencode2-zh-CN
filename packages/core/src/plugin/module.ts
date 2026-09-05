export * as PluginModule from "./module.js"

import type { Plugin } from "@opencode-ai/plugin/effect/plugin"
import { Host } from "@opencode-ai/plugin/host"
import { Npm } from "@opencode-ai/util/npm"
import { importModule, resolveModule } from "@opencode-ai/util/runtime-import"
import { Effect, Schema } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import type { ConfigPluginSource } from "../config/plugin/source.js"
import type { Generation } from "../plugin.js"
import { PluginPromise } from "./promise.js"

const Discovery = Schema.Struct({
  id: Schema.optional(Schema.String),
  markers: Schema.Array(Schema.String),
})

const Definition = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      tui: Schema.optional(Schema.Boolean),
      vcs: Schema.optional(Discovery),
      effect: Schema.declare<Plugin["effect"]>((input): input is Plugin["effect"] => typeof input === "function"),
    }),
    Schema.Struct({
      id: Schema.String,
      tui: Schema.optional(Schema.Boolean),
      vcs: Schema.optional(Discovery),
      setup: Schema.declare<Parameters<typeof PluginPromise.fromPromise>[0]["setup"]>(
        (input): input is Parameters<typeof PluginPromise.fromPromise>[0]["setup"] => typeof input === "function",
      ),
    }),
  ]),
})

export class LoadError extends Schema.TaggedError<LoadError>()("PluginModule.LoadError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const load = Effect.fn("PluginModule.load")(function* (
  operation: Extract<ConfigPluginSource.Operation, { type: "add" }>,
  options?: { readonly install?: boolean },
) {
  const npm = yield* Npm.Service
  const local = path.isAbsolute(operation.target)
  const installed: Npm.EntryPoint = local
    ? { directory: path.dirname(operation.target), entrypoint: pathToFileURL(operation.target).href }
    : options?.install === false
      ? yield* npm.resolve(operation.target, { subpaths: ["server", ""] })
      : yield* npm.add(operation.target, { subpaths: ["server", ""] })
  const resolved: Host.Entrypoints = local ? {} : Host.resolve({ directory: installed.directory }, { resolveModule })
  const entrypoint = installed.entrypoint ?? resolved.server
  if (!local && options?.install === false && !entrypoint) return { pending: true as const }
  if (!entrypoint) return yield* new LoadError({ message: `Plugin entrypoint not found: ${operation.target}` })
  // Bun currently ignores query parameters when caching file:// imports.
  const target = typeof Bun !== "undefined" ? fileURLToPath(entrypoint).replaceAll("\\", "/") : entrypoint
  const source = operation.mtime === undefined ? entrypoint : `${target}?mtime=${operation.mtime}`
  yield* Effect.log({ msg: "loading plugin", id: operation.target, entrypoint: source })
  const mod = yield* Effect.promise(() => Host.load(source, { importModule }))
  const value = (yield* Schema.decodeUnknownEffect(Definition)(mod).pipe(
    Effect.mapError(
      (cause) =>
        new LoadError({
          message: "Plugin must export a default definition with an id and an effect or setup function.",
          cause,
        }),
    ),
  )).default
  const plugin = "effect" in value ? value : PluginPromise.fromPromise(value)
  return {
    id: plugin.id,
    tui: plugin.tui ?? resolved.tui !== undefined,
    vcs: plugin.vcs,
    revision: JSON.stringify([operation, installed.revision]),
    source: local
      ? { type: "local" as const, path: fileURLToPath(entrypoint) }
      : {
          type: "package" as const,
          target: operation.target,
          ...(installed.version ? { version: installed.version } : {}),
        },
    effect: (host) => plugin.effect({ ...host, options: operation.options }),
  } satisfies Generation
})
