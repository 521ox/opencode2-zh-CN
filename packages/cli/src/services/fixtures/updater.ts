import { Effect } from "effect"
import assert from "node:assert/strict"
import { Updater } from "../updater"

const calls: string[] = []
globalThis.fetch = Object.assign(
  async () => {
    calls.push("fetch")
    throw new Error("Unexpected update request")
  },
  { preconnect() {} },
)

await Effect.runPromise(
  Effect.gen(function* () {
    const updater = yield* Updater.Service
    yield* updater.monitor((version) =>
      Effect.sync(() => {
        calls.push(`notify:${version}`)
      }),
    )
    const error = yield* updater.apply("1.18.4-zhcn.2").pipe(Effect.flip)
    assert.equal(error.name, "UpdaterDisabledError")
    assert.match(error.message, /https:\/\/github\.com\/521ox\/opencode2-zh-CN\/releases/)
    assert.deepEqual(calls, [])
  }).pipe(Effect.provide(Updater.layer)),
)
