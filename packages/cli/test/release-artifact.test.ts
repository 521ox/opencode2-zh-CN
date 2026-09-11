import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { bytecodeOptions } from "../script/build-bytecode"
import { createPlatformRelease } from "../script/release-artifact"
import {
  RELEASE_PLATFORMS,
  RELEASE_BUN_VERSION,
  RELEASE_VERSION,
  sha256,
  validateBunVersion,
  validateReleaseSource,
  validateReleaseVersion,
} from "../script/release-contract"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("release artifact contract", () => {
  test("accepts only the fixed selected release version", () => {
    expect(RELEASE_VERSION).toBe("1.18.4-zhcn.2")
    expect(validateReleaseVersion(RELEASE_VERSION)).toBe(RELEASE_VERSION)
    expect(() => validateReleaseVersion("1.18.4-zhcn.1")).toThrow("only accepts version")
    expect(() => validateReleaseVersion("1.18.4-zhcn.3")).toThrow("only accepts version")
    expect(() => validateReleaseVersion("latest")).toThrow("only accepts version")
  })

  test("accepts only the selected Bun version", () => {
    expect(RELEASE_BUN_VERSION).toBe("1.4.2")
    expect(validateBunVersion("1.4.2")).toBe("1.4.2")
    expect(() => validateBunVersion("1.3.14")).toThrow("Release tooling requires Bun 1.4.2")
    expect(() => validateBunVersion("1.4.3")).toThrow("Release tooling requires Bun 1.4.2")
  })

  test("accepts only the fork repository main branch", () => {
    expect(validateReleaseSource("521ox/opencode2-zh-CN", "refs/heads/main")).toEqual({
      repository: "521ox/opencode2-zh-CN",
      ref: "refs/heads/main",
    })
    expect(() => validateReleaseSource("anomalyco/opencode", "refs/heads/main")).toThrow(
      "must run in 521ox/opencode2-zh-CN",
    )
    expect(() => validateReleaseSource("521ox/opencode2-zh-CN", "refs/heads/release-cli")).toThrow(
      "must run from refs/heads/main",
    )
    expect(() => validateReleaseSource("521ox/opencode2-zh-CN", "refs/tags/v1.18.4-zhcn.2")).toThrow(
      "must run from refs/heads/main",
    )
  })

  for (const platform of [RELEASE_PLATFORMS[0], RELEASE_PLATFORMS[2]]) {
    test(`creates deterministic ${platform.format} output and a bound sidecar`, async () => {
      const root = await temporaryRoot()
      const dist = path.join(root, platform.distDirectory)
      const executable = path.join(dist, ...platform.executable.split("/"))
      await mkdir(path.dirname(executable), { recursive: true })
      await writeFile(executable, "synthetic executable")
      await writeFile(path.join(dist, "package.json"), '{"name":"synthetic"}\n')
      const first = path.join(root, "first")
      const second = path.join(root, "second")
      const input = {
        version: RELEASE_VERSION,
        sourceSha: "a".repeat(40),
        runner: platform.runner,
        target: platform.target,
        dist,
        bunVersion: "1.4.2",
        bunRevision: "synthetic-revision",
      }
      const left = await createPlatformRelease({ ...input, output: first })
      const right = await createPlatformRelease({ ...input, output: second })
      const leftArchive = await readFile(left.archivePath)
      const rightArchive = await readFile(right.archivePath)

      expect(leftArchive).toEqual(rightArchive)
      if (platform.format === "tar.gz") expect(gunzipSync(leftArchive).subarray(263, 265).toString("ascii")).toBe("00")
      expect(archiveNames(platform.format, leftArchive)).toEqual([
        `${platform.distDirectory}/`,
        `${platform.distDirectory}/bin/`,
        `${platform.distDirectory}/${platform.executable}`,
        `${platform.distDirectory}/package.json`,
      ])
      expect(left.sidecar.archive.sha256).toBe(sha256(leftArchive))
      expect(left.sidecar.archive.bytes).toBe(leftArchive.byteLength)
      expect(left.sidecar.executable.sha256).toBe(sha256(Buffer.from("synthetic executable")))
      expect(left.sidecar.version).toBe(RELEASE_VERSION)
      expect(left.sidecar.channel).toBe("zh-cn")
      expect(left.sidecar.schemaVersion).toBe(2)
      expect(left.sidecar.bytecode).toBeTrue()
      expect(left.sidecar.bytecode).toBe(bytecodeOptions.bytecode)
      expect(left.sidecar.bun).toEqual({ version: "1.4.2", revision: "synthetic-revision" })
      expect(left.sidecar.unsigned).toBeTrue()
      expect(JSON.parse(await Bun.file(left.sidecarPath).text())).toEqual(left.sidecar)
    })
  }

  test("rejects a runner and target assembled from different matrix entries", async () => {
    const root = await temporaryRoot()
    const platform = RELEASE_PLATFORMS[0]
    const dist = path.join(root, platform.distDirectory)
    await mkdir(path.join(dist, "bin"), { recursive: true })
    await writeFile(path.join(dist, "bin", "opencode2.exe"), "synthetic")
    await expect(
      createPlatformRelease({
        version: RELEASE_VERSION,
        sourceSha: "a".repeat(40),
        runner: platform.runner,
        target: RELEASE_PLATFORMS[1].target,
        dist,
        output: path.join(root, "out"),
        bunVersion: "1.4.2",
        bunRevision: "synthetic-revision",
      }),
    ).rejects.toThrow("Invalid native runner/target pair")
  })
})

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-release-artifact-"))
  roots.push(root)
  return root
}

function archiveNames(format: "zip" | "tar.gz", archive: Buffer) {
  if (format === "tar.gz") {
    const tar = gunzipSync(archive)
    const names: string[] = []
    for (let offset = 0; offset + 512 <= tar.byteLength; ) {
      const header = tar.subarray(offset, offset + 512)
      if (header.every((byte) => byte === 0)) break
      names.push(header.subarray(0, 100).toString("utf8").replace(/\0.*$/, ""))
      const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8)
      offset += 512 + Math.ceil(size / 512) * 512
    }
    return names
  }

  const names: string[] = []
  for (let offset = 0; offset + 30 <= archive.byteLength && archive.readUInt32LE(offset) === 0x04034b50; ) {
    const size = archive.readUInt32LE(offset + 18)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    names.push(archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"))
    offset += 30 + nameLength + extraLength + size
  }
  return names
}
