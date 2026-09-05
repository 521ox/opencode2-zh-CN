import { describe, expect, test } from "bun:test"
import parsers from "../../src/parsers-config"
import { filetype } from "../../src/util/filetype"

describe("util.filetype", () => {
  test("maps filenames to presentation languages", () => {
    expect(filetype("component.tsx")).toBe("typescript")
    expect(filetype("script.js")).toBe("typescript")
    expect(filetype("main.py")).toBe("python")
    expect(filetype("README.unknown")).toBeUndefined()
  })

  test("maps shell filenames to the registered bash parser", () => {
    const languages = ["script.sh", "script.bash", "script.zsh", "script.ksh"].map(filetype)
    expect(languages).toEqual(["bash", "bash", "bash", "bash"])
    expect(parsers.parsers.some((parser) => languages.every((language) => language === parser.filetype))).toBe(true)
  })

  test("pins the diff highlights query to the compatible revision", () => {
    const parser = parsers.parsers.find((item) => item.filetype === "diff")
    expect(parser?.queries?.highlights).toEqual([
      "https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-diff/2520c3f934b3179bb540d23e0ef45f75304b5fed/queries/highlights.scm",
    ])
  })

  test("uses none for missing filenames", () => {
    expect(filetype()).toBe("none")
    expect(filetype("")).toBe("none")
  })
})
