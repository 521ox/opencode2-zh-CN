import { describe, expect, test } from "bun:test"
import { action, decodePolicy } from "./updater"

describe("updater", () => {
  test("reads autoupdate from JSONC", () => {
    expect(decodePolicy('{ // preference\n "autoupdate": "notify",\n}')).toBe("notify")
    expect(decodePolicy('{ "autoupdate": false }')).toBe(false)
    expect(decodePolicy('{ "autoupdate": "invalid" }')).toBeUndefined()
  })

  test("automatically updates patches", () => {
    expect(action("1.2.3", "1.2.4", true, false)).toBe("upgrade")
    expect(action("1.2.3", "1.2.4", "notify", true)).toBe("confirm")
    expect(action("1.2.3", "1.2.4", false, true)).toBe("none")
  })

  test("requires an interactive confirmation for minors", () => {
    expect(action("1.2.3", "1.3.0", true, true)).toBe("confirm")
    expect(action("1.2.3", "1.3.0", true, false)).toBe("none")
  })

  test("never automatically updates majors", () => {
    expect(action("1.2.3", "2.0.0", true, true)).toBe("none")
  })
})
