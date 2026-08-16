import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { resolveCpuProfileTarget } from "../src/framework/runtime"

describe("resolveCpuProfileTarget", () => {
  test("prefers the explicit global flag", () => {
    expect(resolveCpuProfileTarget("serve", Option.some("explicit.cpuprofile"), "inherited.cpuprofile")).toBe(
      "explicit.cpuprofile",
    )
  })

  test("uses the inherited profile for a private serve process", () => {
    expect(resolveCpuProfileTarget("serve", Option.none(), "inherited.cpuprofile")).toBe("inherited.cpuprofile")
  })

  test("ignores the inherited profile for non-serve commands", () => {
    expect(resolveCpuProfileTarget("opencode", Option.none(), "inherited.cpuprofile")).toBeUndefined()
  })
})
