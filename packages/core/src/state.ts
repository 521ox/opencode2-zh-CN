export * as State from "./state.js"

import { Context, Effect, Scope, Semaphore } from "effect"

/**
 * A replayable transform applied to an editor during reload.
 *
 * Domain editors expose readable and writable state while preserving concise
 * plugin/config code. Transforms synchronously rebuild derived state.
 */
type TransformCallback<Editor> = (editor: Editor) => void
export type MakeEditor<State, Editor> = (state: State) => Editor

export interface Registration {
  readonly dispose: Effect.Effect<void>
}

/**
 * Registers and applies a scoped transform. Closing the owning Scope removes
 * the transform and reloads the materialized state.
 */
export type Transform<Editor> = (
  transform: TransformCallback<Editor>,
) => Effect.Effect<Registration, never, Scope.Scope>

export type Reload = () => Effect.Effect<void>

export interface Transformable<Editor> {
  readonly transform: Transform<Editor>
  readonly reload: Reload
}

export interface Failure {
  readonly state: string
  readonly cause: unknown
}

type GroupedRegistration = {
  readonly remove: () => boolean
  readonly notify: Effect.Effect<void>
}

type RegistrationGroup = {
  failed: boolean
  readonly registrations: Set<GroupedRegistration>
  readonly report: (failure: Failure, refresh: Effect.Effect<void>) => void
}

const CurrentGroup = Context.Reference<RegistrationGroup | undefined>("@opencode/State/CurrentGroup", {
  defaultValue: () => undefined,
})

/** Groups registrations so a failed transform can synchronously detach the complete plugin contribution. */
export function group(report: RegistrationGroup["report"]) {
  const group: RegistrationGroup = { failed: false, registrations: new Set(), report }
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, CurrentGroup, group)
}

function disable(group: RegistrationGroup, failure: Failure) {
  if (group.failed) return
  group.failed = true
  const notifications = new Set<Effect.Effect<void>>()
  for (const registration of group.registrations) {
    registration.remove()
    notifications.add(registration.notify)
  }
  group.report(
    failure,
    Effect.forEach(notifications, (notify) => notify, { discard: true }),
  )
}

type Batch = {
  active: boolean
  readonly flush: boolean
  readonly reloads: Set<Reload>
}

const CurrentBatch = Context.Reference<Batch | undefined>("@opencode/State/CurrentBatch", {
  defaultValue: () => undefined,
})
/** flush: false is terminal teardown: states whose transforms are removed stop rebuilding. */
export function batch<A, E, R>(effect: Effect.Effect<A, E, R>, options: { readonly flush?: boolean } = {}) {
  return Effect.gen(function* () {
    const current = yield* CurrentBatch
    if (current?.active && options.flush !== false) return yield* effect
    const batch: Batch = { active: true, flush: options.flush !== false, reloads: new Set() }
    const exit = yield* effect.pipe(Effect.provideService(CurrentBatch, batch), Effect.exit)
    batch.active = false
    if (batch.flush) yield* Effect.forEach(batch.reloads, (reload) => reload(), { discard: true })
    return yield* exit
  })
}

export const inherit = Effect.fnUntraced(function* () {
  const batch = yield* CurrentBatch
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, CurrentBatch, batch)
})

export interface Options<State, Editor> {
  readonly name?: string
  /** Creates the base value for initial state and every scoped-transform reload. */
  readonly initial: () => State
  /** Wraps mutable state in a domain-specific editor API. */
  readonly editor: MakeEditor<State, Editor>
  /**
   * Runs after the rebuilt state becomes visible. Update events published here
   * act as read barriers: subscribers refetching on the event observe the
   * committed state.
   */
  readonly notify?: (state: State) => Effect.Effect<void>
}

export interface Interface<State, Editor> extends Transformable<Editor> {
  readonly get: () => State
}

export function create<State, Editor>(options: Options<State, Editor>): Interface<State, Editor> {
  let state = options.initial()
  const transforms = new Set<{ run: TransformCallback<Editor>; group: RegistrationGroup | undefined }>()
  let version = 0
  let closed = false
  const semaphore = Semaphore.makeUnsafe(1)

  const invalidate = () => {
    version++
  }

  const commit = Effect.fn("State.commit")(function* (next: State) {
    state = next
    if (options.notify) yield* options.notify(next)
  })

  const materialize = Effect.fnUntraced(function* () {
    if (closed) return
    while (true) {
      const started = version
      const next = options.initial()
      const api = options.editor(next)
      for (const transform of transforms) {
        try {
          transform.run(api)
        } catch (cause) {
          if (!transform.group) throw cause
          disable(transform.group, { state: options.name ?? "anonymous", cause })
        }
        if (version !== started) break
      }
      if (version !== started) continue
      yield* commit(next)
      return
    }
  })

  const materializeReload = () => semaphore.withPermit(materialize())
  const reload = Effect.gen(function* () {
    if (closed) return
    const batch = yield* CurrentBatch
    if (batch?.active) {
      if (!batch.flush) {
        closed = true
        return
      }
      batch.reloads.add(materializeReload)
      return
    }
    yield* materializeReload()
  })

  return {
    get: () => state,
    transform: Effect.fn("State.transform")(function* (update) {
      yield* Effect.annotateCurrentSpan("state", options.name ?? "anonymous")
      const scope = yield* Scope.Scope
      const group = yield* CurrentGroup
      if (group?.failed) return { dispose: Effect.void }
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const transform = { run: update, group }
          const registration: GroupedRegistration = {
            remove: () => {
              if (!transforms.delete(transform)) return false
              group?.registrations.delete(registration)
              invalidate()
              return true
            },
            // One stable Effect per State lets a failed group deduplicate affected domains.
            notify: reload,
          }
          const dispose = Effect.uninterruptible(
            semaphore.withPermit(
              Effect.suspend(() => {
                if (!registration.remove()) return Effect.void
                return Effect.gen(function* () {
                  const batch = yield* CurrentBatch
                  if (batch?.active) {
                    // Terminal teardown must not rebuild state while registrations are being removed.
                    if (!batch.flush) {
                      closed = true
                      return
                    }
                    batch.reloads.add(materializeReload)
                    return
                  }
                  yield* materialize()
                })
              }),
            ),
          )
          yield* semaphore.withPermit(
            Effect.sync(() => {
              transforms.add(transform)
              group?.registrations.add(registration)
              invalidate()
            }),
          )
          yield* Scope.addFinalizer(scope, dispose)
          const batch = yield* CurrentBatch
          if (batch?.active) batch.reloads.add(materializeReload)
          else yield* materializeReload()
          return { dispose }
        }),
      )
    }),
    reload: () => reload,
  }
}
