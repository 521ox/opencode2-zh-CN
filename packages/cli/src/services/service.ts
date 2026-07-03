import { Global } from "@opencode-ai/core/global"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { ServiceEffect } from "@opencode-ai/client/service/effect"
import { Effect, FileSystem, Schedule, Schema } from "effect"
import { HttpServer } from "effect/unstable/http"
import { randomBytes, randomUUID } from "crypto"
import path from "path"

// Binds the client package's service operations to this CLI: which
// registration file (by channel), which version, and how to spawn opencode.
// Also owns the service config file and the server-side registration write.

const ServiceConfig = Schema.Struct({
  hostname: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65_535))),
  password: Schema.optional(Schema.String),
})
export type ServiceConfig = typeof ServiceConfig.Type

const serviceConfigKeys = ["hostname", "port", "password"] as const
type ServiceConfigKey = (typeof serviceConfigKeys)[number]

const decodeServiceConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceConfig))

function serviceConfigKey(key: string): ServiceConfigKey {
  if (serviceConfigKeys.includes(key as ServiceConfigKey)) return key as ServiceConfigKey
  throw new Error(`Unknown service config key: ${key}`)
}

const env = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const filename = InstallationChannel === "local" ? "service-local.json" : "service.json"
  return {
    fs,
    stateDir: global.state,
    file: path.join(global.state, filename),
    configFile: path.join(global.config, filename),
  }
})

const options = Effect.fnUntraced(function* () {
  const { file } = yield* env
  const compiled = path.basename(process.execPath).replace(/\.exe$/, "") !== "bun"
  const entrypoint = compiled ? undefined : process.argv[1]
  if (!compiled && entrypoint === undefined) return yield* Effect.fail(new Error("Failed to resolve CLI entrypoint"))
  return {
    file,
    version: InstallationVersion,
    command: [process.execPath, ...(entrypoint ? [entrypoint] : []), "serve", "--service"],
  }
})

export const discover = Effect.fn("cli.service.discover")(function* () {
  const found = yield* ServiceEffect.discover(yield* options())
  return found?.transport
})

export const start = Effect.fn("cli.service.start")(function* () {
  return yield* ServiceEffect.start(yield* options())
})

export const connect = Effect.fn("cli.service.connect")(function* () {
  return yield* ServiceEffect.connect(yield* options())
})

export const stop = Effect.fn("cli.service.stop")(function* () {
  return yield* ServiceEffect.stop(yield* options())
})

export const config = Effect.fn("cli.service.config")(function* () {
  const { fs, configFile } = yield* env
  return yield* fs.readFileString(configFile).pipe(
    Effect.flatMap(decodeServiceConfig),
    Effect.catch(() => Effect.succeed({} as ServiceConfig)),
  )
})

const writeConfig = Effect.fn("cli.service.writeConfig")(function* (value: ServiceConfig) {
  const { fs, configFile } = yield* env
  const temp = configFile + ".tmp"
  yield* fs.makeDirectory(path.dirname(configFile), { recursive: true })
  yield* fs.writeFileString(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  yield* fs.rename(temp, configFile)
})

export const password = Effect.fn("cli.service.password")(function* (value?: string) {
  const existing = yield* config()
  if (value === undefined && existing.password) return existing.password
  const next = value ?? randomBytes(32).toString("base64url")

  // Keep one private credential across server restarts so discovered clients
  // can reconnect without exposing a password flag or environment variable.
  yield* writeConfig({ ...existing, password: next })
  return next
})

export const get = Effect.fn("cli.service.get")(function* (key?: string) {
  if (key === undefined) {
    const { password: _password, ...safe } = yield* config()
    return JSON.stringify(safe, null, 2)
  }
  switch (serviceConfigKey(key)) {
    case "hostname": {
      return (yield* config()).hostname ?? ""
    }
    case "port": {
      const port = (yield* config()).port
      return port === undefined ? "" : String(port)
    }
    case "password": {
      return yield* password()
    }
  }
})

export const set = Effect.fn("cli.service.set")(function* (key: string, value: string) {
  switch (serviceConfigKey(key)) {
    case "hostname": {
      yield* stop()
      yield* writeConfig({ ...(yield* config()), hostname: value })
      return
    }
    case "port": {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port must be between 1 and 65535")
      yield* stop()
      yield* writeConfig({ ...(yield* config()), port })
      return
    }
    case "password": {
      yield* stop()
      yield* password(value)
      return
    }
  }
})

export const unset = Effect.fn("cli.service.unset")(function* (key: string) {
  switch (serviceConfigKey(key)) {
    case "hostname": {
      yield* stop()
      const { hostname: _hostname, ...next } = yield* config()
      yield* writeConfig(next)
      return
    }
    case "port": {
      yield* stop()
      const { port: _port, ...next } = yield* config()
      yield* writeConfig(next)
      return
    }
    case "password": {
      yield* stop()
      const { password: _password, ...next } = yield* config()
      yield* writeConfig(next)
      return
    }
  }
})

// Server-side half of the registration protocol, run by `serve --service` at
// boot. The registration embeds the password so the file alone is enough for
// any client to discover and authenticate. service.json arbitrates ownership
// after concurrent starts; it is not a startup lock: the atomic rename elects
// the latest writer, the watcher self-evicts losers, and the finalizer
// id-guard keeps an exiting server from deleting its successor's registration.
export const register = Effect.fn("cli.service.register")(function* (address: HttpServer.Address) {
  const { fs, stateDir, file } = yield* env
  const id = randomUUID()
  const secret = yield* password()
  const temp = file + "." + id + ".tmp"
  yield* fs.makeDirectory(stateDir, { recursive: true })
  yield* fs.writeFileString(
    temp,
    JSON.stringify({
      id,
      version: InstallationVersion,
      url: HttpServer.formatAddress(address),
      pid: process.pid,
      password: secret,
    }),
    { mode: 0o600 },
  )
  yield* fs.rename(temp, file)
  yield* ServiceEffect.readRegistration(file).pipe(
    Effect.flatMap((info) =>
      info?.id === id
        ? Effect.void
        : Effect.try({ try: () => process.kill(process.pid, "SIGTERM"), catch: (cause) => cause }).pipe(Effect.ignore),
    ),
    Effect.repeat(Schedule.spaced("10 seconds")),
    Effect.forkScoped,
  )
  yield* Effect.addFinalizer(() =>
    ServiceEffect.readRegistration(file).pipe(
      Effect.flatMap((info) => (info?.id === id ? fs.remove(file) : Effect.void)),
      Effect.ignore,
    ),
  )
})

export * as Service from "./service"
