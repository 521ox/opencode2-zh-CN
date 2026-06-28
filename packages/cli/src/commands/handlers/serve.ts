import { NodeHttpServer } from "@effect/platform-node"
import { Credential } from "@opencode-ai/core/credential"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Context, Layer, Option } from "effect"
import * as Effect from "effect/Effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { createRoutes } from "@opencode-ai/server/routes"
import { ServerAuth } from "@opencode-ai/server/auth"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Daemon } from "../../services/daemon"
import { Updater } from "../../services/updater"

export default Runtime.handler(
  Commands.commands.serve,
  Effect.fn("cli.serve")(function* (input) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* Daemon.Service
        const standalonePassword = process.env.OPENCODE_SERVER_PASSWORD
        if (input.stdio) delete process.env.OPENCODE_SERVER_PASSWORD
        const password = input.stdio ? standalonePassword : yield* daemon.password()
        if (!password) return yield* Effect.fail(new Error("Missing server password"))
        const address = yield* listen(input.hostname, input.port, password)
        yield* Effect.tryPromise(() =>
          createOpencodeClient({
            baseUrl: HttpServer.formatAddress(address),
            headers: ServerAuth.headers({ password }),
          }).v2.location.get(undefined, { throwOnError: true }),
        )
        if (input.register) yield* daemon.register(address)
        const url = HttpServer.formatAddress(address)
        console.log(input.stdio ? JSON.stringify({ url }) : `server listening on ${url}`)
        const updater = yield* Updater.Service
        yield* updater.check().pipe(Effect.forkScoped)
        return yield* (input.stdio ? waitForStdinClose() : Effect.never)
      }).pipe(Effect.annotateLogs({ role: "server" })),
    )
  }),
)

function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)
      process.stdin.off("close", close)
      process.stdin.pause()
    })
  })
}

function listen(hostname: string, port: Option.Option<number>, password: string) {
  if (Option.isSome(port)) return bind(hostname, port.value, password)
  const next = (port: number): ReturnType<typeof bind> =>
    bind(hostname, port, password).pipe(
      Effect.catch((error) => (port === 65_535 ? Effect.fail(error) : next(port + 1))),
    )
  return next(4096)
}

function bind(hostname: string, port: number, password: string) {
  const server = createServer()
  return Layer.build(
    HttpRouter.serve(createRoutes(password), { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => server, { port, host: hostname })),
      Layer.provide(Credential.defaultLayer),
      Layer.provide(PermissionSaved.defaultLayer),
    ),
  ).pipe(
    Effect.tap(() => Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))),
    Effect.map((context) => Context.get(context, HttpServer.HttpServer).address),
  )
}
