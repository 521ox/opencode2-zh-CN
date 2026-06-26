import { run } from "@opencode-ai/tui"
import { TuiConfig } from "@opencode-ai/tui/config"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { loadBuiltinPlugins } from "@opencode-ai/tui/builtins"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

export function runTui(transport: { url: string; headers: RequestInit["headers"] }) {
  const config = TuiConfig.resolve({}, { terminalSuspend: false })
  let disposeSlots: (() => void) | undefined
  return Effect.gen(function* () {
    const options = { baseUrl: transport.url, headers: transport.headers }
    const client = createOpencodeClient(options)
    const directory = yield* Effect.tryPromise(() =>
      client.v2.fs.list({ location: { directory: process.cwd() } }, { throwOnError: true }),
    ).pipe(
      Effect.map((response) => response.data.location.directory),
      Effect.catch(() =>
        Effect.tryPromise(() => client.v2.location.get(undefined, { throwOnError: true })).pipe(
          Effect.map((response) => response.data.directory),
        ),
      ),
    )
    return yield* run({
      client: createOpencodeClient({ ...options, directory }),
      args: {},
      config,
      pluginHost: {
        async start(input) {
          disposeSlots = await loadBuiltinPlugins(input.api, input.runtime)
        },
        async dispose() {
          disposeSlots?.()
        },
      },
    })
  }).pipe(Effect.provide(Global.defaultLayer))
}
