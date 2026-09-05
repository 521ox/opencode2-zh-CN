import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPlatformRelease } from "../script/release-artifact"
import { RELEASE_PLATFORMS, RELEASE_VERSION } from "../script/release-contract"
import { assembleRelease } from "../script/release-manifest"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("six-way release fan-in", () => {
  test("accepts exactly six matching artifacts and writes deterministic manifests", async () => {
    const fixture = await releaseFixture()
    const output = path.join(fixture.root, "release")
    const manifest = await assembleRelease({
      version: RELEASE_VERSION,
      sourceSha: fixture.sourceSha,
      artifacts: fixture.artifacts,
      output,
    })

    expect(manifest.platforms).toHaveLength(6)
    expect(new Set(manifest.platforms.map((item) => item.target)).size).toBe(6)
    expect(manifest.platforms.every((item) => item.sourceSha === fixture.sourceSha)).toBeTrue()
    expect(manifest.platforms.every((item) => item.unsigned)).toBeTrue()
    const sums = (await readFile(path.join(output, "SHA256SUMS"), "utf8")).trim().split("\n")
    expect(sums).toHaveLength(13)
    const names = sums.map((line) => line.slice(line.indexOf("  ") + 2))
    expect(names).toEqual([...names].toSorted())
    expect(JSON.parse(await readFile(path.join(output, "release-manifest.json"), "utf8"))).toEqual(manifest)
  })

  test("rejects missing or extra downloaded artifacts", async () => {
    const missing = await releaseFixture()
    await rm(path.join(missing.artifacts, `release-${RELEASE_PLATFORMS[0].target}`), { recursive: true })
    await expect(
      assembleRelease({
        version: RELEASE_VERSION,
        sourceSha: missing.sourceSha,
        artifacts: missing.artifacts,
        output: path.join(missing.root, "out"),
      }),
    ).rejects.toThrow("exactly six")

    const extra = await releaseFixture()
    await mkdir(path.join(extra.artifacts, "release-unexpected"))
    await expect(
      assembleRelease({
        version: RELEASE_VERSION,
        sourceSha: extra.sourceSha,
        artifacts: extra.artifacts,
        output: path.join(extra.root, "out"),
      }),
    ).rejects.toThrow("found 7")
  })

  test("rejects sidecar hash and identity mismatches", async () => {
    const fixture = await releaseFixture()
    const platform = RELEASE_PLATFORMS[0]
    const sidecar = path.join(fixture.artifacts, `release-${platform.target}`, `${platform.archive}.json`)
    const value = JSON.parse(await readFile(sidecar, "utf8"))
    value.archive.sha256 = "0".repeat(64)
    await writeFile(sidecar, JSON.stringify(value, null, 2) + "\n")
    await expect(
      assembleRelease({
        version: RELEASE_VERSION,
        sourceSha: fixture.sourceSha,
        artifacts: fixture.artifacts,
        output: path.join(fixture.root, "out"),
      }),
    ).rejects.toThrow("Archive contract mismatch")

    const duplicate = await releaseFixture()
    const duplicatePlatform = RELEASE_PLATFORMS[0]
    await writeFile(
      path.join(duplicate.artifacts, `release-${duplicatePlatform.target}`, "duplicate-sidecar.json"),
      "{}\n",
    )
    await expect(
      assembleRelease({
        version: RELEASE_VERSION,
        sourceSha: duplicate.sourceSha,
        artifacts: duplicate.artifacts,
        output: path.join(duplicate.root, "out"),
      }),
    ).rejects.toThrow("must contain only")
  })
})

async function releaseFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-release-manifest-"))
  roots.push(root)
  const artifacts = path.join(root, "artifacts")
  const sourceSha = "b".repeat(40)
  await mkdir(artifacts)
  for (const platform of RELEASE_PLATFORMS) {
    const dist = path.join(root, "dist", platform.distDirectory)
    const executable = path.join(dist, ...platform.executable.split("/"))
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(executable, `synthetic ${platform.target}`)
    await writeFile(path.join(dist, "package.json"), `{"target":"${platform.target}"}\n`)
    const source = path.join(root, "built", platform.target)
    await createPlatformRelease({
      version: RELEASE_VERSION,
      sourceSha,
      runner: platform.runner,
      target: platform.target,
      dist,
      output: source,
      bunVersion: "1.3.14",
      bunRevision: "synthetic-revision",
    })
    await cp(source, path.join(artifacts, `release-${platform.target}`), { recursive: true })
  }
  return { root, artifacts, sourceSha }
}
