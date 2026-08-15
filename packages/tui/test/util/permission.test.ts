import { expect, test } from "bun:test"
import { permissionPresentation } from "../../src/util/permission"
import { translate, type Translator } from "../../src/i18n"

const chinese: Translator = (key, params) => translate("zh", key, params)

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})

test("localizes permission chrome without changing dynamic values", () => {
  expect(
    permissionPresentation(
      { action: "read", resources: [], input: { path: "src/index.ts" } },
      (value) => value,
      chinese,
    ),
  ).toMatchObject({
    title: "读取 src/index.ts",
    lines: ["路径：src/index.ts"],
  })
  expect(
    permissionPresentation(
      { action: "websearch", resources: [], metadata: { provider: "parallel", query: "OpenCode v2" } },
      (value) => value,
      chinese,
    ),
  ).toMatchObject({
    title: 'Parallel 网页搜索 "OpenCode v2"',
    lines: ["查询：OpenCode v2"],
  })
})
