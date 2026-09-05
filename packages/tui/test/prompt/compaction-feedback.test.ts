import { expect, test } from "bun:test"
import { translate, type Translator } from "../../src/i18n"
import { compactionFailureToast } from "../../src/component/prompt"

const translator =
  (locale: "en" | "zh"): Translator =>
  (key, params) =>
    translate(locale, key, params)

test("Main compaction feedback treats both cancellation codes as warnings in the default Chinese locale", () => {
  const t = translator("zh")

  expect(compactionFailureToast(t, { type: "aborted", message: "raw cancellation" })).toEqual({
    message: "会话压缩已取消",
    variant: "warning",
  })
  expect(compactionFailureToast(t, { type: "compaction.interrupted", message: "raw interruption" })).toEqual({
    message: "会话压缩已取消",
    variant: "warning",
  })
  expect(compactionFailureToast(t, { type: "provider.error", message: "raw provider failure" })).toEqual({
    message: "会话压缩失败：raw provider failure",
    variant: "error",
  })
})

test("Main compaction feedback retains the explicit English locale", () => {
  expect(
    compactionFailureToast(translator("en"), { type: "compaction.interrupted", message: "raw interruption" }),
  ).toEqual({
    message: "Session compaction cancelled",
    variant: "warning",
  })
})
