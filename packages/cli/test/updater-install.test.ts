import { expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Updater } from "../src/services/updater"

test("explicit updater paths reject before requests or installation", async () => {
  const request = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        throw new Error("Unexpected update request")
      },
      { preconnect: fetch.preconnect },
    ),
  )

  try {
    const updater = Effect.runSync(Updater.Service.pipe(Effect.provide(Updater.layer)))
    const operations: ReadonlyArray<Effect.Effect<unknown, Updater.DisabledError>> = [
      updater.ensureEnabled(),
      updater.latest(),
      updater.apply("latest"),
      ...Updater.methods.map((method) => updater.upgrade(method, "latest")),
    ]

    for (const operation of operations) {
      const error = await Effect.runPromise(operation.pipe(Effect.flip))
      expect(error).toBeInstanceOf(Updater.DisabledError)
      expect(error.message).toContain(Updater.RELEASES_URL)
    }
    expect(request).not.toHaveBeenCalled()
  } finally {
    request.mockRestore()
  }
})
