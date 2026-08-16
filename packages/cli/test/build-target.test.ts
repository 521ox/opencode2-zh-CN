import { describe, expect, test } from "bun:test"
import { matchesSingleTarget } from "../script/build-target"

describe("matchesSingleTarget", () => {
  const normal = { os: "win32", arch: "x64" } as const
  const baseline = { os: "win32", arch: "x64", avx2: false } as const

  test("selects only the normal x64 target by default", () => {
    expect(matchesSingleTarget(normal, "win32", "x64", false)).toBeTrue()
    expect(matchesSingleTarget(baseline, "win32", "x64", false)).toBeFalse()
  })

  test("selects only the baseline x64 target when requested", () => {
    expect(matchesSingleTarget(normal, "win32", "x64", true)).toBeFalse()
    expect(matchesSingleTarget(baseline, "win32", "x64", true)).toBeTrue()
  })

  test("rejects baseline mode on arm64", () => {
    expect(matchesSingleTarget({ os: "win32", arch: "arm64" }, "win32", "arm64", true)).toBeFalse()
  })

  test("excludes ABI-specific targets from the default single build", () => {
    expect(matchesSingleTarget({ os: "linux", arch: "x64", abi: "musl" }, "linux", "x64", false)).toBeFalse()
  })
})
