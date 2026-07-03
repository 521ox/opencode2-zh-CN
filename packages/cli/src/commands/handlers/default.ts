import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Global } from "@opencode-ai/core/global"
import { Effect, FileSystem, Option } from "effect"
import { Service } from "../../services/service"
import { Standalone } from "../../services/standalone"
import { Updater } from "../../services/updater"
import { basicAuth } from "@opencode-ai/client/service"
import type { Transport } from "@opencode-ai/client/service"

export default Runtime.handler(Commands, (input) =>
  Effect.gen(function* () {
    const directory = Option.getOrUndefined(input.directory)
    if (directory !== undefined) process.chdir(directory)
    const updater = yield* Updater.Service
    yield* updater.check().pipe(Effect.forkScoped)
    const server = Option.getOrUndefined(input.server)
    if (server !== undefined && input.standalone)
      return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
    const transport = yield* resolveTransport(server, input.standalone)
    const { runTui } = yield* Effect.promise(() => import("../../tui"))
    // The TUI re-runs discover whenever its event stream drops. For an explicit
    // --server or a standalone child the transport is fixed, so reconnects
    // retry the same address; for the managed service discovery re-reads the
    // registration and may start a replacement.
    const context = yield* Effect.context<FileSystem.FileSystem | Global.Service>()
    const discover =
      server !== undefined || input.standalone
        ? () => Promise.resolve(transport)
        : () => Effect.runPromise(Service.connect().pipe(Effect.provide(context)))
    yield* runTui(transport, { continue: input.continue, sessionID: Option.getOrUndefined(input.session) }, discover)
  }),
)

function resolveTransport(server: string | undefined, standalone: boolean) {
  if (server !== undefined) {
    const password = process.env["OPENCODE_SERVER_PASSWORD"]
    return Effect.succeed({
      url: server,
      headers: password ? basicAuth(password) : undefined,
    } satisfies Transport)
  }
  if (standalone) return Standalone.transport()
  return Service.connect()
}
