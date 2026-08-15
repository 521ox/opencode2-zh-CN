import { describe, expect, test } from "bun:test"
import { cliErrorMessage, errorFormat, errorMessage } from "../../src/util/error"
import { translate, type Translator } from "../../src/i18n"

const chinese: Translator = (key, params) => translate("zh", key, params)

describe("util.error", () => {
  test("formats native Error instances", () => {
    const err = new Error("boom")
    expect(errorMessage(err)).toBe("boom")
    expect(errorFormat(err)).toContain("boom")
  })

  test("extracts message from record-like values", () => {
    const err = { message: "bad input", code: "E_BAD" }
    expect(errorMessage(err)).toBe("bad input")
  })

  test("never returns bare {} for opaque object errors", () => {
    expect(errorFormat({})).not.toBe("{}")
    expect(errorFormat({})).toContain("no message")

    class OpaqueError {}
    const opaque = new OpaqueError()
    Object.defineProperty(opaque, "secret", { value: "hidden", enumerable: false })
    expect(errorFormat(opaque)).not.toBe("{}")
    expect(errorFormat(opaque)).toContain("OpaqueError")
  })

  test("handles opaque throwables with custom toString", () => {
    const err = {
      toString() {
        return "ResolveMessage: Cannot resolve module"
      },
    }

    expect(errorMessage(err)).toBe("ResolveMessage: Cannot resolve module")
  })

  test("localizes TUI-owned structured startup errors", () => {
    expect(
      cliErrorMessage(
        {
          _tag: "ProviderModelNotFoundError",
          providerID: "mycodex",
          modelID: "gpt-test",
          suggestions: ["gpt-next"],
        },
        chinese,
      ),
    ).toBe(
      [
        "未找到模型：mycodex/gpt-test",
        "你是否想用：gpt-next",
        "请运行 `opencode models` 查看可用模型",
        "或检查配置（opencode.json）中的提供商/模型名称",
      ].join("\n"),
    )
    expect(cliErrorMessage({ _tag: "ProviderInitError", providerID: "mycodex" }, chinese)).toBe(
      "初始化提供商“mycodex”失败。请检查凭据和配置。",
    )
  })
})
