import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Updater } from "../src/services/updater"

describe("upgrade command", () => {
  test("is registered in root help and documents its options", async () => {
    const root = await cli(["--help"], {}, "../src/index.ts")
    const help = await cli(["upgrade", "--help"], {}, "../src/index.ts")
    expect(root.exitCode).toBe(0)
    expect(root.stdout).toContain("upgrade")
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("[<target>]")
    expect(help.stdout).toContain("--method")
    expect(help.stdout).toContain("-m")
  })

  test("routes root update to application upgrade without shadowing plugin update", async () => {
    const application = await cli(["update", "--help"], {}, "../src/index.ts")
    const plugin = await cli(["plugin", "update", "--help"], {}, "../src/index.ts")

    expect(application.exitCode).toBe(0)
    expect(application.stdout).toContain("Upgrade OpenCode to the latest or a specific version")
    expect(application.stdout).toContain("--method")
    expect(application.stdout).not.toContain("Update package plugins")

    expect(plugin.exitCode).toBe(0)
    expect(plugin.stdout).toContain("Update package plugins")
    expect(plugin.stdout).not.toContain("--method")
    expect(plugin.stdout).not.toContain("Upgrade OpenCode to the latest or a specific version")
  })

  test("rejects before method detection, release lookup, or installation", async () => {
    const result = await cli(["v1.18.4-zhcn.2", "--method", "npm"])
    expect(result.exitCode).toBe(1)
    expect(result.events).toEqual([])
    expect(`${result.stdout}\n${result.stderr}`).toContain(Updater.RELEASES_URL)
  })

  test("root upgrade and update aliases return the same disabled failure", async () => {
    for (const command of ["upgrade", "update"]) {
      const result = await cli([command], {}, "../src/index.ts")
      const output = `${result.stdout}\n${result.stderr}`
      expect(result.exitCode, command).toBe(1)
      expect(output, command).toContain("Updates are disabled for this fork")
      expect(output, command).toContain(Updater.RELEASES_URL)
      expect(output, command).not.toContain("Using method")
      expect(output, command).not.toContain("Upgrading...")
    }
  })
})

async function cli(args: string[], env: Record<string, string> = {}, entry = "fixture/upgrade.ts") {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-upgrade-"))
  try {
    const child = Bun.spawn(
      [process.execPath, "--define", 'OPENCODE_VERSION="1.18.4-zhcn.1"', path.join(import.meta.dir, entry), ...args],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: {
          ...process.env,
          OPENCODE_TEST_HOME: root,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const events = stdout
      .split("\n")
      .filter((line) => line.startsWith("EVENT "))
      .map((line) => JSON.parse(line.slice(6)))
    expect(await Bun.file(path.join(root, "state", "opencode", "service-local.json")).exists()).toBe(false)
    return { stdout, stderr, exitCode, events }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
