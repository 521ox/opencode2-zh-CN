import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { State } from "@opencode-ai/core/state"
import { it } from "./lib/effect"

describe("State replay", () => {
  it.effect("replays active transforms in registration order without mutating retained values", () =>
    Effect.gen(function* () {
      let source = 2
      const state = State.create({
        initial: () => ({ value: source, order: [] as string[] }),
        editor: (value) => value,
      })
      const first = yield* state.transform((editor) => {
        editor.value += 3
        editor.order.push("add")
      })
      yield* state.transform((editor) => {
        editor.value *= 4
        editor.order.push("multiply")
      })
      const retained = state.get()
      expect(retained).toEqual({ value: 20, order: ["add", "multiply"] })

      source = 5
      yield* state.reload()
      expect(state.get()).toEqual({ value: 32, order: ["add", "multiply"] })
      expect(retained).toEqual({ value: 20, order: ["add", "multiply"] })

      yield* first.dispose
      expect(state.get()).toEqual({ value: 20, order: ["multiply"] })
      expect(retained).toEqual({ value: 20, order: ["add", "multiply"] })
    }),
  )
})
