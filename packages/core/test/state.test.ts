import { describe, expect } from "bun:test"
import { State } from "@opencode-ai/core/state"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("State", () => {
  it.effect("commits a transform atomically when its updater is interrupted", () =>
    Effect.gen(function* () {
      const rebuilding = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let block = true
      const state = State.create({
        initial: () => ({ values: [] as string[] }),
        editor: (editor) => ({ add: (value: string) => editor.values.push(value) }),
        notify: () =>
          block ? Deferred.succeed(rebuilding, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void,
      })
      const scope = yield* Scope.make()
      const fiber = yield* state
        .transform((editor) => {
          editor.add("registered")
        })
        .pipe(Scope.provide(scope), Effect.forkChild)
      yield* Deferred.await(rebuilding)
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
      block = false
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interruption)

      expect(state.get().values).toEqual(["registered"])
      yield* Scope.close(scope, Exit.void)
      expect(state.get().values).toEqual([])
    }),
  )

  it.effect("passes rebuilt state after making it visible", () =>
    Effect.gen(function* () {
      const observed: string[][] = []
      const state: State.Interface<{ values: string[] }, { add: (item: string) => void }> = State.create({
        initial: () => ({ values: [] as string[] }),
        editor: (editor) => ({ add: (item: string) => editor.values.push(item) }),
        notify: (value) =>
          Effect.sync(() => {
            expect(state.get()).toBe(value)
            observed.push([...value.values])
          }),
      })

      yield* state.transform((editor) => {
        editor.add("value")
      })

      // Update events publish from notify, so consumers reading on the event
      // must observe the rebuilt state, not the previous one.
      expect(observed).toEqual([["value"]])
    }),
  )

  it.effect("runs transforms during every reload", () =>
    Effect.gen(function* () {
      let value = "first"
      const state = State.create({
        initial: () => ({ values: [] as string[] }),
        editor: (editor) => ({ add: (item: string) => editor.values.push(item) }),
      })

      yield* state.transform((editor) => {
        editor.add(value)
      })
      expect(state.get().values).toEqual(["first"])

      value = "second"
      yield* state.reload()
      expect(state.get().values).toEqual(["second"])
    }),
  )

  it.effect("disposes a transform once and rebuilds remaining state", () =>
    Effect.gen(function* () {
      const state = State.create({
        initial: () => ({ values: [] as string[] }),
        editor: (editor) => ({ add: (item: string) => editor.values.push(item) }),
      })
      yield* state.transform((editor) => {
        editor.add("first")
      })
      const registration = yield* state.transform((editor) => {
        editor.add("second")
      })
      expect(state.get().values).toEqual(["first", "second"])

      yield* registration.dispose
      expect(state.get().values).toEqual(["first"])

      yield* registration.dispose
      expect(state.get().values).toEqual(["first"])
    }),
  )

  it.effect("batches automatic rebuilds", () =>
    Effect.gen(function* () {
      let finalized = 0
      const first = State.create({
        initial: () => ({ values: [] as string[] }),
        editor: (editor) => ({ add: (item: string) => editor.values.push(item) }),
        notify: () => Effect.sync(() => finalized++),
      })
      const second = State.create({
        initial: () => ({ values: [] as string[] }),
        editor: (editor) => ({ add: (item: string) => editor.values.push(item) }),
        notify: () => Effect.sync(() => finalized++),
      })

      yield* State.batch(
        Effect.gen(function* () {
          yield* first.transform((editor) => {
            editor.add("first")
          })
          yield* first.transform((editor) => {
            editor.add("second")
          })
          yield* second.transform((editor) => {
            editor.add("third")
          })
          expect(finalized).toBe(0)
        }),
      )

      expect(first.get().values).toEqual(["first", "second"])
      expect(second.get().values).toEqual(["third"])
      expect(finalized).toBe(2)
    }),
  )

  it.effect("discards teardown rebuilds while still running cleanup", () =>
    Effect.gen(function* () {
      let finalized = 0
      let disposed = 0
      const state = State.create({
        initial: () => ({ values: [] as string[] }),
        editor: (editor) => ({ add: (item: string) => editor.values.push(item) }),
        notify: () => Effect.sync(() => finalized++),
      })
      const scope = yield* Scope.make()
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => disposed++),
      )
      const registration = yield* state.transform((editor) => editor.add("value")).pipe(Scope.provide(scope))
      expect(finalized).toBe(1)

      yield* State.batch(Scope.close(scope, Exit.void), { flush: false })
      expect(disposed).toBe(1)
      expect(finalized).toBe(1)

      yield* registration.dispose
      yield* state.reload()
      expect(finalized).toBe(1)
    }),
  )

  it.effect("keeps teardown suppression separate from an enclosing live batch", () =>
    Effect.gen(function* () {
      const finalized: string[] = []
      const closing = State.create({
        initial: () => ({}),
        editor: (editor) => editor,
        notify: () => Effect.sync(() => finalized.push("closing")),
      })
      const live = State.create({
        initial: () => ({}),
        editor: (editor) => editor,
        notify: () => Effect.sync(() => finalized.push("live")),
      })
      const scope = yield* Scope.make()
      yield* closing.transform(() => {}).pipe(Scope.provide(scope))
      finalized.length = 0

      yield* State.batch(
        Effect.gen(function* () {
          yield* live.transform(() => {})
          yield* State.batch(Scope.close(scope, Exit.void), { flush: false })
        }),
      )
      expect(finalized).toEqual(["live"])
    }),
  )

  it.effect("notifies once per reload without waiting", () =>
    Effect.gen(function* () {
      let finalized = 0
      const state = State.create({
        initial: () => ({ values: [] as string[] }),
        editor: (editor) => ({ add: (item: string) => editor.values.push(item) }),
        notify: () => Effect.sync(() => finalized++),
      })
      yield* state.transform((editor) => {
        editor.add("value")
      })
      finalized = 0

      yield* state.reload()
      expect(finalized).toBe(1)
      yield* state.reload()
      expect(finalized).toBe(2)
    }),
  )
})
