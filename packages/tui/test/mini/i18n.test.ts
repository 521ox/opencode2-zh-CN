import { describe, expect, test } from "bun:test"
import { DEFAULT_LOCALE, resolveLocale, translate } from "../../src/i18n"
import { dict as en } from "../../src/i18n/en/mini"
import { dict as zh } from "../../src/i18n/zh/mini"

describe("Mini translations", () => {
  test("uses Chinese for the default locale and English when selected explicitly", () => {
    expect(DEFAULT_LOCALE).toBe("zh")
    expect(translate(resolveLocale(undefined), "mini.command.commands")).toBe("命令")
    expect(translate(resolveLocale(undefined), "mini.tool.match.other", { count: 2 })).toBe("2 个匹配项")

    expect(translate("en", "mini.command.commands")).toBe("Commands")
    expect(translate("en", "mini.tool.match.other", { count: 2 })).toBe("2 matches")
  })

  test("covers every Mini dictionary key in Chinese", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
