import { describe, expect, test } from "bun:test"
import { ShellScan } from "../../src/shell/scan.js"

describe("portable compound shell syntax", () => {
  test.each([
    "probe() for value in one two; do scan_probe; done; probe",
    "function probe() case value in value) scan_probe;; esac; probe",
    "printf '%s' \"$( probe-name() if true; then scan_probe; fi; probe-name )\"",
  ])("keeps compound function bodies visible: %s", (source) => {
    const result = ShellScan.scan(source)
    expect(result.kind).toBe("scanned")
    if (result.kind !== "scanned") throw new Error(result.reason)
    expect(result.commands.map((command) => command.words[0])).toContain("scan_probe")
  })

  test.each([
    "for x (one two) for y (a b) scan_probe",
    "for x ($(printf one)) { scan_probe; }",
    "for x (one two) [[ $(scan_probe) == ok ]]",
  ])("retains commands in Zsh parenthesized loops: %s", (source) => {
    const result = ShellScan.scan(source)
    expect(result.kind).toBe("scanned")
    if (result.kind !== "scanned") throw new Error(result.reason)
    expect(result.commands.map((command) => command.words[0])).toContain("scan_probe")
  })
})
