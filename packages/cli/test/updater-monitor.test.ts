import { expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Updater } from "../src/services/updater"

test("default monitor emits no update and performs no request", async () => {
  const request = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        throw new Error("Unexpected update request")
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const notifications: string[] = []

  try {
    const updater = Effect.runSync(Updater.Service.pipe(Effect.provide(Updater.layer)))
    await Effect.runPromise(
      updater.monitor((version) =>
        Effect.sync(() => {
          notifications.push(version)
        }),
      ),
    )
    expect(notifications).toEqual([])
    expect(request).not.toHaveBeenCalled()
  } finally {
    request.mockRestore()
  }
})
