import { describe, expect, test } from "bun:test"
import { DEFAULT_LOCALE, resolveLocale, translate } from "../src/i18n"
import { dict as en } from "../src/i18n/en"
import { dict as zh } from "../src/i18n/zh"
import { dict as app } from "../src/i18n/en/app"
import { dict as common } from "../src/i18n/en/common"
import { dict as dialogs } from "../src/i18n/en/dialogs"
import { dict as feature } from "../src/i18n/en/feature"
import { dict as mini } from "../src/i18n/en/mini"
import { dict as misc } from "../src/i18n/en/misc"
import { dict as session } from "../src/i18n/en/session"
import { dict as ui } from "../src/i18n/en/ui"

const placeholders = (value: string) =>
  Array.from(value.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g), (match) => match[1]).sort()

describe("TUI i18n", () => {
  test("defaults the custom build to Simplified Chinese", () => {
    expect(DEFAULT_LOCALE).toBe("zh")
    expect(resolveLocale(undefined)).toBe("zh")
    expect(resolveLocale("zh-CN")).toBe("zh")
  })

  test("supports an explicit English locale", () => {
    expect(resolveLocale("en-US")).toBe("en")
    expect(translate("en", "common.action.close")).toBe("Close")
    expect(translate("zh", "common.action.close")).toBe("关闭")
    expect(translate("en", "app.command.session.new")).toBe("New session")
    expect(translate("zh", "app.command.session.new")).toBe("新建会话")
    expect(translate("en", "misc.plugin.failed.title", { target: "example" })).toBe("Plugin failed: example")
    expect(translate("zh", "misc.plugin.failed.title", { target: "example" })).toBe("插件加载失败：example")
    expect(translate("zh", "misc.plugin.failed.message")).toBe("运行 /plugins 查看详细信息。")
    expect(translate("zh", "misc.plugin.failed.action")).toBe("打开插件")
  })

  test("interpolates named parameters", () => {
    expect(translate("en", "common.status.items", { count: 3 })).toBe("3 items")
    expect(translate("zh", "common.status.items", { count: 3 })).toBe("3 项")
    expect(translate("en", "feature.plugins.updateFailed", { id: "sample" })).toBe("Failed to update plugin sample")
    expect(translate("zh", "feature.plugins.updateFailed", { id: "sample" })).toBe("无法更新插件 sample")
    expect(translate("en", "feature.diff.fileCount.other", { count: 2 })).toBe("2 files")
    expect(translate("zh", "feature.diff.fileCount.other", { count: 2 })).toBe("2 个文件")
  })

  test("keeps the Simplified Chinese dictionary complete", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(zh[key]!)).toEqual(placeholders(en[key]))
    }
  })

  test("keeps domain keys unique", () => {
    const keys = [common, app, dialogs, feature, mini, misc, session, ui].flatMap(Object.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
