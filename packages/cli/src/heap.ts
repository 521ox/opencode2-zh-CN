export * as Heap from "./heap"

import { Global } from "@opencode-ai/util/global"
import { Effect, Queue, Scope } from "effect"
import { lstat, rename, rm, unlink, writeFile } from "node:fs/promises"
import { watch } from "node:fs"
import path from "node:path"

const retryCount = 3
const retryDelay = 50
const triggerEnvironment = "OPENCODE_HEAP_TRIGGER"

type Watch = (directory: string, listener: (event: string, file: string | Buffer | null) => void) => { close(): void }
type Options = {
  readonly directory: string
  readonly enabled: boolean
  readonly platform?: NodeJS.Platform
  readonly pid?: number
  readonly watch?: Watch
  readonly marker?: (file: string) => Promise<number | undefined>
  readonly remove?: (file: string) => Promise<void>
  readonly consume?: (file: string) => Promise<boolean>
  readonly claim?: (source: string, target: string) => Promise<boolean>
  readonly capture?: (file: string) => Promise<void>
  readonly now?: () => Date
  readonly delay?: number
}

export const listen = Effect.gen(function* () {
  const enabled = isTriggerEnabled(process.env)
  if (!enabled) return
  const global = yield* Global.Service
  yield* Effect.logInfo("heap trigger listener enabled")
  yield* listenWith({ directory: global.log, enabled })
})

/** @internal Heap snapshot triggers are opt-in to avoid observing local markers by default. */
export function isTriggerEnabled(environment: Readonly<Record<string, string | undefined>>) {
  return environment[triggerEnvironment] === "1"
}

/** @internal Exported for owner-local Windows listener tests. */
export function listenWith(options: Options): Effect.Effect<void, never, Scope.Scope> {
  if (!options.enabled) return Effect.void
  const platform = options.platform ?? process.platform
  const pid = options.pid ?? process.pid
  if (platform === "win32") return listenWindows(options.directory, pid, options)
  return listenSignal(options.directory, pid)
}

function listenSignal(directory: string, pid: number): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const signals = yield* Queue.dropping<void>(1)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const handler = () => Queue.offerUnsafe(signals, undefined)
        process.on("SIGUSR1", handler)
        return handler
      }),
      (handler) => Effect.sync(() => process.off("SIGUSR1", handler)),
    )
    yield* Queue.take(signals).pipe(
      Effect.andThen(Effect.suspend(() => capture(directory, pid))),
      Effect.forever,
      Effect.forkScoped({ startImmediately: true }),
    )
  })
}

function listenWindows(directory: string, pid: number, options: Options): Effect.Effect<void, never, Scope.Scope> {
  const marker = path.join(directory, `heap-${pid}.trigger`)
  const processing = path.join(directory, `heap-${pid}.processing`)
  const failed = path.join(directory, `heap-${pid}.failed`)
  const cleanup = path.join(directory, `heap-${pid}.cleanup`)
  const readMarker = options.marker ?? markerTime
  const remove = options.remove ?? ((file) => rm(file, { force: true }))
  const consume = options.consume ?? consumeMarker
  const claim =
    options.claim ?? (options.consume ? async (source: string) => await options.consume!(source) : claimMarker)
  const subscribe = options.watch ?? ((target, listener) => watch(target, listener))
  const captureSnapshot = options.capture ?? captureHeapSnapshot
  const now = options.now ?? (() => new Date())
  const started = now().getTime()
  return Effect.gen(function* () {
    const triggers = yield* Queue.dropping<number>(1)
    let generation = 0
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        subscribe(directory, (event, file) => {
          if (event !== "rename" && file !== null) return
          if (file && file.toString() !== path.basename(marker)) return
          generation += 1
          Queue.offerUnsafe(triggers, generation)
        }),
      ),
      (watcher) => Effect.sync(() => watcher.close()),
    )
    // The marker is the recoverable request fact. Reconcile only after subscribing.
    yield* Effect.tryPromise(() => readMarker(processing)).pipe(
      Effect.andThen((timestamp) => {
        if (timestamp === undefined || timestamp >= started) return Effect.void
        return Effect.tryPromise(() => readMarker(cleanup)).pipe(
          Effect.andThen((success) =>
            success === undefined
              ? Effect.tryPromise(() => writeReceipt(failed, "stale-processing"))
              : Effect.logWarning("heap snapshot cleanup remained after success", { path: processing }),
          ),
          Effect.andThen(Effect.tryPromise(() => remove(processing))),
          Effect.catchCause((cause) => Effect.logWarning("failed to record stale heap processing", { cause })),
        )
      }),
      Effect.catchCause(() => Effect.void),
    )
    Queue.offerUnsafe(triggers, generation)
    yield* Queue.take(triggers).pipe(
      Effect.andThen((requestGeneration) =>
        Effect.suspend(() => {
          if (requestGeneration < 0) return Effect.void
          const captureRequest = () => {
            const file = path.join(directory, `heap-${pid}-${now().toISOString().replace(/[:.]/g, "")}.heapsnapshot`)
            return retry(() => captureFile(file, captureSnapshot), options.delay).pipe(
              Effect.map(() => true),
              Effect.catchCause((cause) =>
                Effect.tryPromise(() => writeReceipt(failed, "capture-failed")).pipe(
                  Effect.andThen(Effect.tryPromise(() => remove(processing))),
                  Effect.andThen(
                    Effect.logError("failed to write local sensitive heap snapshot; create a new trigger to retry", {
                      path: file,
                      cause,
                    }),
                  ),
                  Effect.as(false),
                ),
              ),
              Effect.flatMap((captured) => {
                if (!captured) return Effect.void
                return Effect.tryPromise(() => writeReceipt(cleanup, "cleanup-pending")).pipe(
                  Effect.andThen(retry(() => Effect.tryPromise(() => remove(processing)), options.delay)),
                  Effect.andThen(retry(() => Effect.tryPromise(() => remove(failed)), options.delay)),
                  Effect.andThen(Effect.tryPromise(() => remove(cleanup))),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("heap snapshot cleanup-failed-after-success", { path: cleanup, cause }),
                  ),
                )
              }),
            )
          }
          return Effect.tryPromise(() => readMarker(marker)).pipe(
            Effect.andThen((timestamp) => {
              if (timestamp !== undefined && timestamp < started)
                return retry(() => Effect.tryPromise(() => remove(marker)), options.delay).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to remove stale heap snapshot trigger", { path: marker, cause }),
                  ),
                )
              if (timestamp !== undefined)
                return retry(() => Effect.tryPromise(() => claim(marker, processing)), options.delay).pipe(
                  Effect.andThen((consumed) => (consumed ? captureRequest() : Effect.void)),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to consume heap snapshot trigger", { path: marker, cause }),
                  ),
                )
              return Effect.void
            }),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to reconcile heap snapshot trigger", { path: marker, cause }),
            ),
          )
        }),
      ),
      Effect.forever,
      Effect.forkScoped({ startImmediately: true }),
    )
  })
}

function retry<A, R>(
  attempt: () => Effect.Effect<A, unknown, R>,
  delay = retryDelay,
  remaining = retryCount - 1,
): Effect.Effect<A, unknown, R> {
  return attempt().pipe(
    Effect.catchCause((cause) => {
      if (remaining === 0) return Effect.failCause(cause)
      return Effect.sleep(delay).pipe(Effect.andThen(() => retry(attempt, delay, remaining - 1)))
    }),
  )
}

function capture(directory: string, pid: number) {
  return captureFile(
    path.join(directory, `heap-${pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`),
    captureHeapSnapshot,
  )
}

function captureFile(file: string, capture: (file: string) => Promise<void>) {
  return Effect.logInfo("writing local sensitive heap snapshot", { path: file }).pipe(
    Effect.andThen(Effect.tryPromise(() => capture(file))),
    Effect.andThen(Effect.logInfo("local sensitive heap snapshot written", { path: file })),
  )
}

async function captureHeapSnapshot(file: string) {
  await Bun.write(file, Bun.generateHeapSnapshot("v8", "arraybuffer"))
}

async function markerTime(file: string) {
  try {
    const stat = await lstat(file)
    return stat.isFile() ? stat.mtimeMs : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}

async function consumeMarker(file: string) {
  try {
    await unlink(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function claimMarker(source: string, target: string) {
  try {
    await rename(source, target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function writeReceipt(file: string, reason: "capture-failed" | "stale-processing" | "cleanup-pending") {
  await writeFile(file, JSON.stringify({ time: new Date().toISOString(), reason }) + "\n")
}
