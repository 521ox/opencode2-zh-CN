import { expect, test } from "bun:test"
import { ShellScan } from "../../src/shell/scan.js"

test.each([
  "probe-name() { scan_probe; }; probe-name",
  "function probe.name { scan_probe; }; probe.name",
  "probe:name() if true; then scan_probe; fi; probe:name",
  "probe()# ignored ) }\n{ scan_probe; }; probe",
  "function \\\nprobe() # ignored \\\n{ scan_probe; }; probe",
  "() { scan_probe; }",
])("accepts portable function-head regressions: %s", (source) => {
  const result = ShellScan.scan(source)
  expect(result.kind).toBe("scanned")
  if (result.kind !== "scanned") throw new Error(result.reason)
  expect(result.commands.map((command) => command.words[0])).toContain("scan_probe")
})

test.each(["[[ -n <(scan_probe) ]]", "[[ -n >(scan_probe) ]]"])(
  "retains conditional process substitutions: %s",
  (source) => {
    const result = ShellScan.scan(source)
    expect(result.kind).toBe("scanned")
    if (result.kind !== "scanned") throw new Error(result.reason)
    expect(result.commands.map((command) => command.words[0])).toContain("scan_probe")
  },
)

test.each(["[[ -n '<(scan_ignored)' ]]", '[[ -n "<(scan_ignored)" ]]'])(
  "does not scan quoted process-substitution text: %s",
  (source) => expect(ShellScan.scan(source)).toEqual({ kind: "scanned", commands: [] }),
)
