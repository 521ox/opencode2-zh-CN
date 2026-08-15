import { expect, test } from "bun:test"
import { localizeSettings, settingID, settings } from "../../../src/component/dialog-config"
import { translate, type Locale, type Translator } from "../../../src/i18n"

const translator = (locale: Locale): Translator => (key, params) => translate(locale, key, params)

test("exposes a Simplified Chinese default with an explicit English option", () => {
  const setting = settings.find((item) => settingID(item) === "locale")

  expect(setting).toMatchObject({
    default: "zh",
    values: ["zh", "en"],
    labels: ["Simplified Chinese", "English"],
  })
})

test("localizes the language setting and command-palette metadata", () => {
  const english = localizeSettings(translator("en")).find((item) => settingID(item) === "locale")
  const chinese = localizeSettings(translator("zh")).find((item) => settingID(item) === "locale")

  expect(english).toMatchObject({
    title: "Interface language",
    category: "Appearance",
    labels: ["Simplified Chinese", "English"],
  })
  expect(chinese).toMatchObject({
    title: "界面语言",
    category: "外观",
    labels: ["简体中文", "English"],
  })
})
