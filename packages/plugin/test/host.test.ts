import { expect, test } from "bun:test"
import { Host } from "../src/host"

const capture = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

test("treats Bun-style non-Error missing resolutions as optional entrypoint misses", () => {
  const missing = { code: "ERR_MODULE_NOT_FOUND" }
  const entrypoints = Host.resolve(
    { directory: "/plugin", name: "fixture" },
    {
      resolveModule: () => {
        throw missing
      },
    },
  )

  expect(entrypoints).toEqual({ server: undefined, tui: undefined, rpc: undefined })
})

test("rethrows an unknown resolution code without changing the failure", () => {
  const failure = { code: "EACCES" }
  const caught = capture(() =>
    Host.resolve(
      { directory: "/plugin", name: "fixture" },
      {
        resolveModule: () => {
          throw failure
        },
      },
    ),
  )

  expect(caught).toBe(failure)
})

test("rethrows an unstructured resolution failure", () => {
  const failure = "resolution failed"
  const caught = capture(() =>
    Host.resolve(
      { directory: "/plugin", name: "fixture" },
      {
        resolveModule: () => {
          throw failure
        },
      },
    ),
  )

  expect(caught).toBe(failure)
})

test("returns a resolved endpoint while optional endpoints remain absent", () => {
  const missing = { code: "ERR_MODULE_NOT_FOUND" }
  const entrypoints = Host.resolve(
    { directory: "/plugin", name: "fixture" },
    {
      resolveModule: (specifier) => {
        if (specifier === "fixture/server") return "file:///plugin/server.mjs"
        throw missing
      },
    },
  )

  expect(entrypoints).toEqual({ server: "file:///plugin/server.mjs", tui: undefined, rpc: undefined })
})
