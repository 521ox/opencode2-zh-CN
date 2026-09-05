import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { Updater } from "./updater"
import { action } from "./updater-action"

describe("fork updater", () => {
  test("owns a stable disabled error with the fork Releases URL", () => {
    const error = new Updater.DisabledError()
    expect(error.name).toBe("UpdaterDisabledError")
    expect(error.message).toContain(Updater.RELEASES_URL)
  })

  test("provides a side-effect-free disabled service", async () => {
    const updater = Effect.runSync(Updater.Service.pipe(Effect.provide(Updater.layer)))
    expect(Effect.runSync(updater.method())).toBeUndefined()

    const error = await Effect.runPromise(updater.ensureEnabled().pipe(Effect.flip))
    expect(error).toBeInstanceOf(Updater.DisabledError)
  })

  test("runtime and build source contain no upstream updater path and identify the fork repository", async () => {
    const owner = await Bun.file(path.join(import.meta.dir, "updater.ts")).text()
    const build = await Bun.file(path.join(import.meta.dir, "../../script/build.ts")).text()
    const changedSource = `${owner}\n${build}`

    expect(changedSource).not.toContain("update.opencode.ai")
    expect(changedSource).not.toContain("opencode.ai/v2/install")
    expect(changedSource).not.toContain("@opencode-ai/cli")
    expect(owner).not.toContain("AppProcess")
    expect(owner).not.toContain("ChildProcess")
    expect(owner).not.toContain("fetch(")
    expect(build).toContain('repository: { type: "git", url: "git+https://github.com/521ox/opencode2-zh-CN.git" }')
    expect(build).not.toContain("git+https://github.com/anomalyco/opencode.git")
  })
})

describe("updater action", () => {
  test("reports every available release", () => {
    expect(action("1.2.3", "1.2.4", "notify")).toBe("notify")
    expect(action("1.2.3", "1.3.0", "notify")).toBe("notify")
    expect(action("1.2.3", "2.0.0", "notify")).toBe("notify")
    expect(action("1.2.3", "1.2.3", "notify")).toBe("none")
  })

  test("skips when updates are disabled", () => {
    expect(action("1.2.3", "1.2.4", "disable")).toBe("none")
  })

  test("reports up-to-date only when versions match", () => {
    expect(action("1.2.3", "1.2.3", "notify")).toBe("none")
  })

  test("reports when latest is lower (rollback)", () => {
    expect(action("1.2.4", "1.2.3", "notify")).toBe("notify")
  })

  test("accepts strict release version variants", () => {
    expect(action("v1.2.3", " 1.2.4\n", "notify")).toBe("notify")
    expect(action("1.2.3-alpha.1", "1.2.3-alpha.2", "notify")).toBe("notify")
    expect(action("0.0.0-dev-17403", "0.0.0-dev-17403.2", "notify")).toBe("notify")
    expect(action("0.0.0-next-17403", "0.0.0-beta-17404", "notify")).toBe("notify")
    expect(action("1.2.3+old", "1.2.3+new", "notify")).toBe("none")
    expect(action("v1.2.3+old", "1.2.3", "notify")).toBe("none")
  })

  test("preserves strict validity", () => {
    const invalid = [
      "=1.2.3",
      "V1.2.3",
      "1.2",
      "1.2.3.4",
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-01",
      "1.2.3-",
      "1.2.3+",
      "1.2.3-alpha..1",
      "1.2.3_alpha",
      "9007199254740992.0.0",
      "0.9007199254740992.0",
      "0.0.9007199254740992",
    ]
    invalid.forEach((version) => expect(action("1.2.3", version, "notify"), version).toBe("none"))
  })

  test("handles numeric limits without losing precision", () => {
    expect(action("9007199254740991.0.0", "9007199254740991.0.1", "notify")).toBe("notify")
    expect(action("9007199254740990.0.0", "9007199254740991.0.0", "notify")).toBe("notify")
  })

  test("preserves equality for oversized numeric prerelease identifiers", () => {
    expect(action("1.0.0-9007199254740992", "1.0.0-9007199254740993", "notify")).toBe("none")
    expect(action("1.0.0-9007199254740991", "1.0.0-9007199254740992", "notify")).toBe("notify")
  })

  test("rejects versions longer than semver's limit before trimming", () => {
    expect(action("1.2.3", `${" ".repeat(251)}1.2.3`, "notify")).toBe("none")
    expect(action("1.2.3", `1.2.4+${"a".repeat(250)}`, "notify")).toBe("notify")
  })
})
