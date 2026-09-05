import { expect } from "bun:test"
import { Effect } from "effect"
import { State } from "@opencode-ai/core/state"
import { it } from "./lib/effect"

it.effect("detaches every registration of a failed group and refreshes every affected domain", () =>
  Effect.gen(function* () {
    const notices: string[] = []
    const failures: State.Failure[] = []
    let refresh = Effect.void
    let fail = false
    const grouped = State.group((failure, changed) => {
      failures.push(failure)
      refresh = changed
    })
    const first = State.create({
      name: "first",
      initial: () => ({ values: [] as string[] }),
      editor: (value) => value,
      notify: () => Effect.sync(() => void notices.push("first")),
    })
    const second = State.create({
      name: "second",
      initial: () => ({ values: [] as string[] }),
      editor: (value) => value,
      notify: () => Effect.sync(() => void notices.push("second")),
    })
    yield* first.transform((draft) => draft.values.push("healthy"))
    const registration = yield* first.transform((draft) => draft.values.push("grouped")).pipe(grouped)
    yield* first.transform((draft) => draft.values.push("also grouped")).pipe(grouped)
    yield* second
      .transform((draft) => {
        draft.values.push("partial")
        if (fail) throw new Error("broken")
      })
      .pipe(grouped)
    const before = first.get()
    notices.length = 0
    fail = true
    yield* second.reload()

    expect(first.get().values).toEqual(["healthy", "grouped", "also grouped"])
    expect(second.get().values).toEqual([])
    expect(before.values).toEqual(["healthy", "grouped", "also grouped"])
    expect(failures).toHaveLength(1)
    expect(failures[0]?.state).toBe("second")

    notices.length = 0
    yield* refresh
    expect(first.get().values).toEqual(["healthy"])
    expect(notices.toSorted()).toEqual(["first", "second"])
    yield* registration.dispose
    expect(notices).toHaveLength(2)
    yield* first.transform((draft) => draft.values.push("resurrected")).pipe(grouped)
    expect(first.get().values).toEqual(["healthy"])
  }),
)

it.effect("restarts a candidate after a grouped transform partially edits it", () =>
  Effect.gen(function* () {
    const reported: string[] = []
    const first = State.group((failure) => reported.push(failure.state))
    const second = State.group((failure) => reported.push(failure.state))
    const state = State.create({
      name: "registry",
      initial: () => ({ values: [] as string[] }),
      editor: (value) => value,
    })

    yield* State.batch(
      Effect.gen(function* () {
        yield* state
          .transform((draft) => {
            draft.values.push("first")
            throw new Error("first failed")
          })
          .pipe(first)
        yield* state
          .transform((draft) => {
            draft.values.push("second")
            throw new Error("second failed")
          })
          .pipe(second)
        yield* state.transform((draft) => draft.values.push("healthy"))
      }),
    )

    expect(state.get().values).toEqual(["healthy"])
    expect(reported).toEqual(["registry", "registry"])
    yield* state.reload()
    expect(reported).toHaveLength(2)
  }),
)

it.effect("does not disable a group when notification fails after a complete replay", () =>
  Effect.gen(function* () {
    let reported = 0
    let fail = true
    const grouped = State.group(() => reported++)
    const state = State.create({
      initial: () => ({ value: 0 }),
      editor: (value) => value,
      notify: () => (fail ? Effect.die("observer failed") : Effect.void),
    })
    yield* state.transform((draft) => draft.value++).pipe(grouped, Effect.exit)
    expect(reported).toBe(0)
    expect(state.get().value).toBe(1)
    fail = false
    yield* state.reload()
    expect(state.get().value).toBe(1)
  }),
)
