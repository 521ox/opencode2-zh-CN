import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "../../core/test/lib/effect"
import { PackageOperation } from "../src/commands/handlers/plugin/package-operation"

const it = testEffect(Layer.empty)

it.effect("fails one never-settling TUI package update after two minutes", () =>
  Effect.gen(function* () {
    let calls = 0
    const operation = Effect.sync(() => calls++).pipe(Effect.andThen(Effect.never))
    const fiber = yield* PackageOperation.run("update", "tui-update", operation).pipe(Effect.flip, Effect.forkScoped)

    yield* Effect.yieldNow
    yield* TestClock.adjust("119 seconds")
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust("1 second")

    const error = yield* Fiber.join(fiber)
    expect(error).toBeInstanceOf(PackageOperation.PackageOperationTimeoutError)
    expect(error).toMatchObject({ operation: "update", target: "tui-update" })
    expect(error.message).toBe("Timed out updating TUI plugin package after 2 minutes: tui-update")
    expect(calls).toBe(1)
  }),
)
