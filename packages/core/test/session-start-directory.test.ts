import path from "path"
import { describe, expect, test } from "bun:test"
import { SessionStartDirectory } from "@opencode-ai/core/session/start-directory"
import { AbsolutePath } from "@opencode-ai/core/schema"

describe("session start directory", () => {
  test("accepts an absolute non-root directory for the current platform", () => {
    const directory = path.resolve("session-start-directory")
    expect(SessionStartDirectory.validate(directory)).toBe(AbsolutePath.make(directory))
  })

  test("rejects missing, relative, root, and NUL-containing values", () => {
    expect(SessionStartDirectory.validate(undefined)).toBeUndefined()
    expect(SessionStartDirectory.validate("relative/path")).toBeUndefined()
    expect(SessionStartDirectory.validate(path.parse(path.resolve("session-start-directory")).root)).toBeUndefined()
    expect(SessionStartDirectory.validate(`${path.resolve("session-start-directory")}\0suffix`)).toBeUndefined()
  })

  test("rejects DEL-containing absolute directories from either platform", () => {
    for (const directory of [
      "/home/example/pro\u007fject",
      "C:\\Users\\example\\pro\u007fject",
      "\\\\server\\share\\pro\u007fject",
    ]) {
      expect(SessionStartDirectory.validate(directory)).toBeUndefined()
      expect(SessionStartDirectory.storage(directory)).toBeUndefined()
    }
  })

  test("accepts persisted absolute directories from either platform", () => {
    expect(SessionStartDirectory.validate("C:/Users/example/project")).toBe(
      AbsolutePath.make("C:\\Users\\example\\project"),
    )
    expect(SessionStartDirectory.storage("C:\\Users\\example\\project")).toBe("C:/Users/example/project")
    expect(SessionStartDirectory.validate("/home/example/project")).toBe(AbsolutePath.make("/home/example/project"))
    expect(SessionStartDirectory.storage("/home/example/project")).toBe("/home/example/project")
  })

  test("rejects incomplete Windows roots and accepts a complete UNC directory", () => {
    for (const directory of ["C:relative", "\\project", "\\\\server", "//server", "\\\\server\\share"])
      expect(SessionStartDirectory.validate(directory)).toBeUndefined()
    expect(SessionStartDirectory.validate("\\\\server\\share\\project")).toBe(
      AbsolutePath.make("\\\\server\\share\\project"),
    )
    expect(SessionStartDirectory.storage("\\\\server\\share\\project")).toBe("//server/share/project")
  })
})
