import { EOL } from "node:os"
import { expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "../../core/test/lib/effect"
import { displayVersion, format, type Item } from "../src/commands/handlers/plugin/inventory"
import { PackageOperation } from "../src/commands/handlers/plugin/package-operation"

const it = testEffect(Layer.empty)

test("formats server and TUI package update status", () => {
  const items: Item[] = [
    { runtime: "Server", target: "server", name: "server.plugin", version: "1.2.3", outdated: true },
    { runtime: "TUI", target: "tui", name: "tui", version: "2.0.0", outdated: false },
  ]

  expect(format(items)).toBe(
    ["Server", "  server.plugin 1.2.3 (update available)", "TUI", "  tui 2.0.0 (current)"].join(EOL),
  )
})

test("shortens Git revisions", () => {
  expect(displayVersion("dadba138b7088d61f937869bbc1ef34b1f91188d")).toBe("dadba13")
})

it.effect("fails one never-settling TUI package check after two minutes", () =>
  Effect.gen(function* () {
    let calls = 0
    const operation = Effect.sync(() => calls++).pipe(Effect.andThen(Effect.never))
    const fiber = yield* PackageOperation.run("check", "tui-check", operation).pipe(Effect.flip, Effect.forkScoped)

    yield* Effect.yieldNow
    yield* TestClock.adjust("119 seconds")
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust("1 second")

    const error = yield* Fiber.join(fiber)
    expect(error).toBeInstanceOf(PackageOperation.PackageOperationTimeoutError)
    expect(error).toMatchObject({ operation: "check", target: "tui-check" })
    expect(error.message).toBe("Timed out checking TUI plugin package after 2 minutes: tui-check")
    expect(calls).toBe(1)
  }),
)
