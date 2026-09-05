export * as CpuProfile from "./cpu-profile"

import { Global } from "@opencode-ai/util/global"
import { Effect, FileSystem, Queue } from "effect"
import { Session } from "node:inspector"
import path from "node:path"

export const targetEnvironment = "OPENCODE_CPU_PROFILE"
export const sourceEnvironment = "OPENCODE_CPU_PROFILE_SOURCE"
export const explicitSource = "explicit"

export function inheritedTarget(target = process.env[targetEnvironment], source = process.env[sourceEnvironment]) {
  return source === explicitSource ? target : undefined
}

type ProfileSource = "explicit" | "signal"
type Profile = {
  readonly owner: symbol
  readonly session: Session
}

let active: symbol | undefined

export const listen = Effect.gen(function* () {
  const global = yield* Global.Service
  if (process.platform === "win32") return
  const signals = yield* Queue.dropping<void>(1)
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const handler = () => Queue.offerUnsafe(signals, undefined)
      process.on("SIGPROF", handler)
      return handler
    }),
    (handler) => Effect.sync(() => process.off("SIGPROF", handler)),
  )
  yield* Effect.gen(function* () {
    yield* Queue.take(signals)
    const file = path.join(
      global.log,
      `cpu-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.cpuprofile`,
    )
    yield* run(file, Effect.sleep("10 seconds"), { source: "signal" }).pipe(
      Effect.catchCause((cause) => Effect.logError("Failed to capture CPU profile", { path: file, cause })),
    )
    yield* Queue.poll(signals)
  }).pipe(Effect.forever, Effect.forkScoped({ startImmediately: true }))
})

export function run<A, E, R>(
  file: string,
  effect: Effect.Effect<A, E, R>,
  options: { readonly source?: ProfileSource; readonly createSession?: () => Session } = {},
) {
  const target = path.resolve(file)
  const source = options.source ?? "explicit"
  return Effect.acquireUseRelease(
    acquire(target, source, options.createSession ?? (() => new Session())),
    (profile) => (profile === undefined && source === "signal" ? Effect.void : effect),
    (profile) => stop(profile, target),
  )
}

function acquire(target: string, source: ProfileSource, createSession: () => Session) {
  return Effect.sync(() => {
    if (active !== undefined) return
    const owner = Symbol("cpu-profile")
    active = owner
    return owner
  }).pipe(
    Effect.flatMap((owner) => {
      if (owner === undefined) {
        return (source === "signal"
          ? Effect.logDebug("CPU profile signal ignored because a profile is already active")
          : Effect.logWarning("CPU profile request ignored because a profile is already active")
        ).pipe(Effect.map(() => undefined))
      }
      let session: Session | undefined
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(path.dirname(target), { recursive: true })
        const created = createSession()
        session = created
        created.connect()
        yield* command(created, "Profiler.enable")
        yield* command(created, "Profiler.start")
        yield* Effect.logInfo("CPU profile started", { path: target })
        return { owner, session: created } satisfies Profile
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            release(owner, session)
          }).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      )
    }),
  )
}

function stop(profile: Profile | undefined, target: string) {
  if (profile === undefined) return Effect.void
  return Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        profile.session.post("Profiler.stop", (error, result) => {
          if (error) return reject(error)
          Bun.write(target, JSON.stringify(result.profile)).then(() => resolve(), reject)
        })
      }),
  ).pipe(
    Effect.andThen(Effect.logInfo("CPU profile written", { path: target })),
    Effect.catchCause((cause) => Effect.logError("Failed to write CPU profile", { path: target, cause })),
    Effect.ensuring(
      Effect.sync(() => {
        release(profile.owner, profile.session)
      }),
    ),
  )
}

function release(owner: symbol, session: Session | undefined) {
  try {
    session?.disconnect()
  } finally {
    if (active === owner) active = undefined
  }
}

function command(session: Session, method: "Profiler.enable" | "Profiler.start") {
  return Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        session.post(method, (error) => (error ? reject(error) : resolve()))
      }),
  )
}
