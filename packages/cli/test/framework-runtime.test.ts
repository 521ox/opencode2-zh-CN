import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { CpuProfile } from "../src/cpu-profile"
import { resolveCpuProfileTarget } from "../src/framework/runtime"

describe("resolveCpuProfileTarget", () => {
  test("prefers the explicit global flag", () => {
    expect(resolveCpuProfileTarget("serve", Option.some("explicit.cpuprofile"), "inherited.cpuprofile")).toBe(
      "explicit.cpuprofile",
    )
  })

  test("uses the inherited profile for a private serve process", () => {
    const inherited = CpuProfile.inheritedTarget("inherited.cpuprofile", CpuProfile.explicitSource)
    expect(resolveCpuProfileTarget("serve", Option.none(), inherited)).toBe("inherited.cpuprofile")
  })

  test("ignores the inherited profile for non-serve commands", () => {
    const inherited = CpuProfile.inheritedTarget("inherited.cpuprofile", CpuProfile.explicitSource)
    expect(resolveCpuProfileTarget("opencode", Option.none(), inherited)).toBeUndefined()
  })

  test("rejects an unmarked ambient profile", () => {
    expect(CpuProfile.inheritedTarget("ambient.cpuprofile", undefined)).toBeUndefined()
  })
})
