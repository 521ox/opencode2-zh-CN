#!/usr/bin/env bun

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  RELEASE_CHANNEL,
  RELEASE_BUN_VERSION,
  RELEASE_PLATFORMS,
  RELEASE_REPOSITORY,
  RELEASE_TAG,
  RELEASE_VERSION,
  sha256,
  stableJson,
  validateReleaseVersion,
  writeStableJson,
  type ReleaseManifest,
  type ReleaseSidecar,
} from "./release-contract"

export async function assembleRelease(input: { version: string; sourceSha: string; artifacts: string; output: string }) {
  validateReleaseVersion(input.version)
  if (!/^[0-9a-f]{40}$/.test(input.sourceSha)) throw new Error(`Invalid source SHA: ${input.sourceSha}`)
  const entries = await readdir(input.artifacts, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory())
  const expectedDirectories = new Set(RELEASE_PLATFORMS.map((platform) => `release-${platform.target}`))
  if (entries.length !== expectedDirectories.size || directories.length !== expectedDirectories.size) {
    throw new Error(`Expected exactly six downloaded artifacts, found ${entries.length}`)
  }
  if (directories.some((entry) => !expectedDirectories.has(entry.name))) {
    throw new Error(`Downloaded artifact names do not match the fixed six-platform matrix`)
  }

  await mkdir(input.output, { recursive: true })
  const existingOutput = await readdir(input.output)
  if (existingOutput.length) throw new Error(`Release output must be empty: ${input.output}`)
  const manifestPlatforms: Array<ReleaseManifest["platforms"][number]> = []
  const checksums: Array<{ name: string; sha256: string }> = []
  for (const platform of RELEASE_PLATFORMS) {
    const directory = path.join(input.artifacts, `release-${platform.target}`)
    const names = (await readdir(directory)).toSorted()
    const sidecarName = `${platform.archive}.json`
    if (names.length !== 2 || names[0] !== platform.archive || names[1] !== sidecarName) {
      throw new Error(`Artifact release-${platform.target} must contain only ${platform.archive} and ${sidecarName}`)
    }
    const archivePath = path.join(directory, platform.archive)
    const sidecarPath = path.join(directory, sidecarName)
    const sidecarBody = await readFile(sidecarPath)
    const sidecar = parseSidecar(JSON.parse(sidecarBody.toString("utf8")), platform.target)
    const archiveBody = await readFile(archivePath)
    if (sidecar.sourceSha !== input.sourceSha || sidecar.version !== RELEASE_VERSION || sidecar.channel !== RELEASE_CHANNEL) {
      throw new Error(`Release identity mismatch in ${sidecarName}`)
    }
    if (
      sidecar.runner !== platform.runner ||
      sidecar.target !== platform.target ||
      sidecar.distDirectory !== platform.distDirectory ||
      sidecar.bun.version !== RELEASE_BUN_VERSION ||
      sidecar.executable.path !== platform.executable ||
      sidecar.archive.name !== platform.archive ||
      sidecar.archive.bytes !== archiveBody.byteLength ||
      sidecar.archive.sha256 !== sha256(archiveBody)
    ) {
      throw new Error(`Archive contract mismatch in ${sidecarName}`)
    }
    await copyFile(archivePath, path.join(input.output, platform.archive))
    await copyFile(sidecarPath, path.join(input.output, sidecarName))
    const sidecarHash = sha256(sidecarBody)
    checksums.push({ name: platform.archive, sha256: sidecar.archive.sha256 }, { name: sidecarName, sha256: sidecarHash })
    manifestPlatforms.push({ ...sidecar, sidecar: { name: sidecarName, sha256: sidecarHash } })
  }

  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    repository: RELEASE_REPOSITORY,
    tag: RELEASE_TAG,
    sourceSha: input.sourceSha,
    version: RELEASE_VERSION,
    channel: RELEASE_CHANNEL,
    prerelease: true,
    unsigned: true,
    platforms: manifestPlatforms,
  }
  const manifestName = "release-manifest.json"
  const manifestBody = Buffer.from(stableJson(manifest))
  await writeStableJson(path.join(input.output, manifestName), manifest)
  checksums.push({ name: manifestName, sha256: sha256(manifestBody) })
  checksums.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  await writeFile(path.join(input.output, "SHA256SUMS"), checksums.map((item) => `${item.sha256}  ${item.name}`).join("\n") + "\n")
  return manifest
}

function parseSidecar(value: unknown, target: string): ReleaseSidecar {
  if (!isRecord(value)) throw new Error(`Invalid sidecar for ${target}`)
  exactKeys(value, [
    "schemaVersion",
    "sourceSha",
    "version",
    "channel",
    "bun",
    "runner",
    "target",
    "distDirectory",
    "archive",
    "executable",
    "unsigned",
  ])
  if (!isRecord(value.bun) || !isRecord(value.archive) || !isRecord(value.executable)) {
    throw new Error(`Invalid nested sidecar metadata for ${target}`)
  }
  exactKeys(value.bun, ["version", "revision"])
  exactKeys(value.archive, ["name", "bytes", "sha256"])
  exactKeys(value.executable, ["path", "bytes", "sha256"])
  const strings = [
    value.sourceSha,
    value.version,
    value.channel,
    value.runner,
    value.target,
    value.distDirectory,
    value.bun.version,
    value.bun.revision,
    value.archive.name,
    value.archive.sha256,
    value.executable.path,
    value.executable.sha256,
  ]
  if (
    value.schemaVersion !== 1 ||
    value.unsigned !== true ||
    strings.some((item) => typeof item !== "string" || item.length === 0) ||
    typeof value.archive.bytes !== "number" ||
    !Number.isSafeInteger(value.archive.bytes) ||
    value.archive.bytes < 0 ||
    typeof value.executable.bytes !== "number" ||
    !Number.isSafeInteger(value.executable.bytes) ||
    value.executable.bytes < 0 ||
    !/^[0-9a-f]{64}$/.test(String(value.archive.sha256)) ||
    !/^[0-9a-f]{64}$/.test(String(value.executable.sha256))
  ) {
    throw new Error(`Invalid sidecar values for ${target}`)
  }
  return value as unknown as ReleaseSidecar
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).toSorted()
  const wanted = [...expected].toSorted()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Unexpected metadata keys: ${actual.join(", ")}`)
  }
}

function argument(args: readonly string[], name: string) {
  const prefix = `--${name}=`
  const matches = args.filter((item) => item.startsWith(prefix))
  if (matches.length !== 1) throw new Error(`Expected exactly one --${name}`)
  const value = matches[0].slice(prefix.length)
  if (!value) throw new Error(`Empty --${name}`)
  return value
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const manifest = await assembleRelease({
    version: argument(args, "version"),
    sourceSha: argument(args, "source-sha"),
    artifacts: argument(args, "artifacts"),
    output: argument(args, "output"),
  })
  console.log(stableJson(manifest).trim())
}
