import { EOL } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { OpenCode, type PluginInfo } from "@opencode-ai/client"
import { Host } from "@opencode-ai/plugin/host"
import { Service } from "@opencode-ai/client/effect/service"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { Config } from "../../../config"
import { Global } from "@opencode-ai/util/global"
import { discoverPluginTargets, localPluginDirectories, localSource } from "@opencode-ai/tui/plugin/discovery"
import { Npm } from "@opencode-ai/util/npm"
import { resolveModule } from "@opencode-ai/util/runtime-import"

export default Runtime.handler(
  Commands.commands.plugin.commands.list,
  Effect.fn("cli.plugin.list")(function* (input) {
    const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const response = yield* Effect.promise(() => client.plugin.list({ location: { directory: process.cwd() } }))
    const config = yield* Config.Service
    const global = yield* Global.Service
    const npm = yield* Npm.Service
    const info = yield* config.get()
    const configDirectory = path.dirname(config.path)
    const discovered = yield* Effect.promise(() =>
      localPluginDirectories(process.cwd(), global.config).then(discoverPluginTargets),
    )
    const candidates = [
      ...(info.plugins ?? []).flatMap((entry) => {
        const target = typeof entry === "string" ? entry : entry.package
        return target.startsWith("-") || target === "*" || target.endsWith(".*") || target.startsWith("opencode.")
          ? []
          : [{ target, source: "configured" as const, directory: configDirectory }]
      }),
      ...discovered.map((target) => ({ target, source: "discovered" as const, directory: process.cwd() })),
    ]
    const tui = yield* Effect.forEach(candidates, (candidate) =>
      Effect.gen(function* () {
        const local = localSource(candidate.target, candidate.directory)
        if (!local && !(yield* Effect.promise(() => Npm.isInstallablePackage(candidate.target)))) return []
        const target = local ? { directory: fileURLToPath(local) } : yield* npm.resolve(candidate.target)
        return Host.resolve(target, { resolveModule }).tui ? [candidate] : []
      }),
    ).pipe(
      Effect.map((items) => items.flat().map(({ target, source }) => ({ target, source }))),
    )
    const output = format(
      response.data,
      tui,
      input.builtin,
    )
    if (!output) {
      process.stdout.write("No plugins found" + EOL)
      return
    }
    process.stdout.write(output + EOL)
  }),
)

export function format(
  plugins: readonly PluginInfo[],
  tui: ReadonlyArray<{ readonly target: string; readonly source: "configured" | "discovered" }>,
  builtin = false,
) {
  const server = plugins
    .filter((plugin) => builtin || plugin.source.type !== "builtin")
    .toSorted((a, b) => name(a).localeCompare(name(b)))
    .map((plugin) => `${name(plugin)} (${plugin.status})`)
  const advertised = plugins.flatMap((plugin) =>
    plugin.status === "active" && plugin.tui && plugin.source.type === "package"
      ? [{ target: plugin.source.target, source: "advertised" as const }]
      : [],
  )
  const targets = [...tui, ...advertised]
    .filter((plugin, index, all) => all.findIndex((candidate) => candidate.target === plugin.target) === index)
    .toSorted((a, b) => a.target.localeCompare(b.target))
    .map((plugin) => `${plugin.target} (${plugin.source})`)
  return [
    targets.length ? ["TUI", ...targets].join(EOL) : undefined,
    server.length ? ["Server", ...server].join(EOL) : undefined,
  ]
    .filter((section) => section !== undefined)
    .join(EOL + EOL)
}

function name(plugin: PluginInfo) {
  if (plugin.id) return plugin.id
  if (plugin.source.type === "package") return plugin.source.target
  if (plugin.source.type === "local") return plugin.source.path
  return plugin.source.type
}
