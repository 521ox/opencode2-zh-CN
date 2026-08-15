import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"
import { translate } from "../../src/i18n"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("opencode2 -s ses_123")
})

test("localizes session continuation labels", () => {
  const epilogue = sessionEpilogue(
    { title: "测试会话", sessionID: "ses_zh" },
    (key, params) => translate("zh", key, params),
  )
  expect(epilogue).toContain("会话")
  expect(epilogue).toContain("继续")
  expect(epilogue).toContain("opencode2 -s ses_zh")
})
