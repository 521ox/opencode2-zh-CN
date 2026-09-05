import { expect, test } from "bun:test"
import { parseReleaseVersion } from "../src/services/updater-action"

test("release version validation accepts supported semver and rejects unsafe targets", () => {
  expect(parseReleaseVersion("v2.3.4-beta.1+build.5")).toBeDefined()
  expect(parseReleaseVersion("2.3.4; echo unsafe")).toBeUndefined()
})
