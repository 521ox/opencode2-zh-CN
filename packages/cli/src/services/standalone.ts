import { ServerAuth } from "@opencode-ai/server/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { randomBytes } from "node:crypto"
import path from "node:path"

const Ready = Schema.Struct({ url: Schema.String })
const decodeReady = Schema.decodeUnknownPromise(Schema.fromJsonString(Ready))

function command(password: string) {
  const compiled = path.basename(process.execPath).replace(/\.exe$/, "") !== "bun"
  const entrypoint = compiled ? [] : process.argv[1] ? [process.argv[1]] : []
  if (!compiled && entrypoint.length === 0) throw new Error("Failed to resolve CLI entrypoint")
  return ChildProcess.make(process.execPath, [...entrypoint, "serve", "--stdio", "--port", "0"], {
    cwd: process.cwd(),
    env: { OPENCODE_SERVER_PASSWORD: password },
    extendEnv: true,
    stdin: "ignore",
    stderr: "ignore",
    killSignal: "SIGKILL",
  })
}

export const transport = Effect.fn("cli.standalone.transport")(
  function* () {
    const password = randomBytes(32).toString("base64url")
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const proc = yield* spawner.spawn(command(password))
    const output = yield* proc.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.take(1), Stream.mkString)
    if (!output) return yield* Effect.fail(new Error("Standalone server exited before reporting readiness"))
    const ready = yield* Effect.tryPromise(() => decodeReady(output))
    return { url: ready.url, headers: ServerAuth.headers({ password }) }
  },
  Effect.provide(CrossSpawnSpawner.defaultLayer),
)

export * as Standalone from "./standalone"
