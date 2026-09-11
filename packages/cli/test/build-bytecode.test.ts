import { describe, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  bytecodeOptions,
  bytecodeReleaseNeedsProbe,
  bunRuntimeInfo,
  verifyBytecodeRuntime,
} from "../script/build-bytecode"

test("release runtime selection probes native targets and requires the exact release for foreign targets", () => {
  const release = `bun-v${process.versions.bun}`
  const native = { os: process.platform, arch: process.arch }
  expect(bytecodeReleaseNeedsProbe(release, native)).toBe(true)
  expect(bytecodeReleaseNeedsProbe("canary", native)).toBe(true)
  const foreign = [
    { os: process.platform === "win32" ? "linux" : "win32", arch: process.arch },
    { os: process.platform, arch: process.arch === "x64" ? "arm64" : "x64" },
  ]
  for (const target of foreign) {
    expect(bytecodeReleaseNeedsProbe(release, target)).toBe(false)
    expect(() => bytecodeReleaseNeedsProbe("canary", target)).toThrow("Foreign bytecode runtime requires release")
    expect(() => bytecodeReleaseNeedsProbe("bun-v1.4.0", target)).toThrow("Foreign bytecode runtime requires release")
  }
})

test("bytecode accepts the compiler and rejects a different revision", () => {
  const compiler = bunRuntimeInfo(process.execPath)
  expect(verifyBytecodeRuntime(process.execPath)).toEqual(compiler)
  expect(() => verifyBytecodeRuntime(process.execPath, { ...compiler, revision: "different-revision" })).toThrow(
    "Bytecode runtime mismatch",
  )
})

test("production bytecode options compile ESM with splitting and expose the embedded Bun identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-bytecode-"))
  try {
    const entrypoint = path.join(directory, "index.ts")
    const executable = path.join(directory, process.platform === "win32" ? "fixture.exe" : "fixture")
    await Bun.write(entrypoint, 'console.log((await import("./value.ts")).value)')
    await Bun.write(path.join(directory, "value.ts"), 'export const value = "bytecode-fixture"')
    expect(bytecodeOptions.bytecode).toBe(true)
    const result = await Bun.build({
      ...bytecodeOptions,
      entrypoints: [entrypoint],
      format: "esm",
      splitting: true,
      compile: { outfile: executable, autoloadBunfig: false, autoloadDotenv: false },
    })
    expect(result.success).toBe(true)
    expect(verifyBytecodeRuntime(executable)).toEqual(bunRuntimeInfo(process.execPath))
    const output = Bun.spawnSync([executable], { env: { ...process.env, BUN_BE_BUN: undefined } })
    expect(output.exitCode).toBe(0)
    expect(output.stdout.toString().trim()).toBe("bytecode-fixture")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

describe.skipIf(process.platform !== "win32")("Windows build wrapper", () => {
  const wrapper = path.resolve(import.meta.dirname, "../../../script/build-custom-windows.ps1")
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

  test("default cache runtime is Current and DryRun restores the process environment", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-wrapper-"))
    try {
      const root = await Bun.file(path.resolve(import.meta.dirname, "../../../package.json")).json()
      const bin = path.join(directory, root.packageManager.replace(/^bun@/, ""), "bin")
      await mkdir(bin, { recursive: true })
      await copyFile(process.execPath, path.join(bin, "bun.exe"))
      const result = Bun.spawnSync([
        "pwsh",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$before = $env:PATH; $env:BUN_BE_BUN = '0'; & ${quote(wrapper)} -DryRun -SkipInstall -CompileRuntimeCache ${quote(directory)}; if ($env:PATH -cne $before -or $env:BUN_BE_BUN -cne '0') { throw 'Environment not restored' }`,
      ])
      expect(result.exitCode).toBe(0)
      expect(Bun.stripANSI(result.stdout.toString())).toMatch(/CompileRuntimeMode\s*:\s*Current/)
      expect(Bun.stripANSI(result.stdout.toString())).toMatch(/Bytecode\s*:\s*True/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("incompatible pinned runtime is rejected without downloading and restores PATH", () => {
    const result = Bun.spawnSync([
      "pwsh",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$before = $env:PATH; $env:BUN_BE_BUN = '0'; $rejected = $false; try { & ${quote(wrapper)} -DryRun -BuildBun ${quote(process.execPath)} -CompileRuntime PinnedCanary } catch { if ($_.ToString() -notlike '*cannot run*bytecode*') { throw }; $rejected = $true }; if (-not $rejected) { throw 'Expected runtime rejection' }; if ($env:PATH -cne $before -or $env:BUN_BE_BUN -cne '0') { throw 'Environment not restored' }`,
    ])
    expect(result.exitCode).toBe(0)
  }, 30_000)

  test("missing cached Bun never falls back and explicit Bun must match the root version", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-wrapper-version-"))
    try {
      const missing = Bun.spawnSync([
        "pwsh",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        wrapper,
        "-DryRun",
        "-CompileRuntimeCache",
        directory,
      ])
      expect(missing.exitCode).not.toBe(0)
      expect(missing.stderr.toString()).toContain("no global Bun fallback")

      await mkdir(path.join(directory, "script"), { recursive: true })
      await mkdir(path.join(directory, "packages", "cli"), { recursive: true })
      const fixture = path.join(directory, "script", "build-custom-windows.ps1")
      await copyFile(wrapper, fixture)
      await Bun.write(path.join(directory, "package.json"), JSON.stringify({ packageManager: "bun@0.0.0" }))
      await Bun.write(path.join(directory, "packages", "cli", "package.json"), JSON.stringify({ version: "test" }))
      const mismatch = Bun.spawnSync([
        "pwsh",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fixture,
        "-DryRun",
        "-BuildBun",
        process.execPath,
      ])
      expect(mismatch.exitCode).not.toBe(0)
      expect(mismatch.stderr.toString()).toContain("Bun version mismatch")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
