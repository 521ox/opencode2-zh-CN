import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Plugin } from "../src/plugin.js"

test("keeps plugin info flat while preserving package update state", () => {
  const info = {
    id: Plugin.ID.make("fixture"),
    source: { type: "package", target: "fixture", version: "1.0.0", outdated: true, updating: true },
    status: "active",
    tui: true,
  } as const
  expect(Schema.decodeUnknownSync(Plugin.Info)(info)).toEqual(info)
  expect(() => Schema.decodeUnknownSync(Plugin.Info)({ ...info, state: { status: "active" } })).toThrow()
})

test("round trips optional failure references", () => {
  const failed = {
    source: { type: "local", path: "/fixture/plugin.ts" },
    status: "failed",
    error: "Plugin failed to load",
    ref: "err_a1b2c3d4",
    tui: false,
  } as const
  expect(Schema.decodeUnknownSync(Plugin.Info)(failed)).toEqual(failed)
})
