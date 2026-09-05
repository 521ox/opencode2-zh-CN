#!/usr/bin/env bun

import { mkdir, readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import {
  createReleaseArchive,
  releasePlatform,
  RELEASE_CHANNEL,
  RELEASE_VERSION,
  sha256,
  stableJson,
  validateBunVersion,
  validateReleaseVersion,
  validateReleaseSource,
  writeStableJson,
  type ReleaseSidecar,
} from "./release-contract"

export async function createPlatformRelease(input: {
  version: string
  sourceSha: string
  runner: string
  target: string
  dist: string
  output: string
  bunVersion: string
  bunRevision: string
}) {
  validateReleaseVersion(input.version)
  validateBunVersion(input.bunVersion)
  if (!/^[0-9a-f]{40}$/.test(input.sourceSha)) throw new Error(`Invalid source SHA: ${input.sourceSha}`)
  if (!input.bunVersion || !input.bunRevision) throw new Error("Bun version and revision are required")
  const platform = releasePlatform({ runner: input.runner, target: input.target, distDirectory: path.basename(input.dist) })
  const executable = path.join(input.dist, ...platform.executable.split("/"))
  const executableInfo = await stat(executable)
  if (!executableInfo.isFile()) throw new Error(`Missing release executable: ${executable}`)
  const packageMetadata = path.join(input.dist, "package.json")
  if (!(await stat(packageMetadata)).isFile()) throw new Error(`Missing release package metadata: ${packageMetadata}`)

  await mkdir(input.output, { recursive: true })
  if ((await readdir(input.output)).length) throw new Error(`Release output must be empty: ${input.output}`)
  const archivePath = path.join(input.output, platform.archive)
  const archiveBody = await createReleaseArchive(platform, input.dist, archivePath)
  const executableBody = await readFile(executable)
  const sidecar: ReleaseSidecar = {
    schemaVersion: 1,
    sourceSha: input.sourceSha,
    version: RELEASE_VERSION,
    channel: RELEASE_CHANNEL,
    bun: { version: input.bunVersion, revision: input.bunRevision },
    runner: platform.runner,
    target: platform.target,
    distDirectory: platform.distDirectory,
    archive: { name: platform.archive, bytes: archiveBody.byteLength, sha256: sha256(archiveBody) },
    executable: { path: platform.executable, bytes: executableBody.byteLength, sha256: sha256(executableBody) },
    unsigned: true,
  }
  const sidecarPath = path.join(input.output, `${platform.archive}.json`)
  await writeStableJson(sidecarPath, sidecar)
  return { archivePath, sidecarPath, sidecar }
}

function argumentsMap(args: readonly string[]) {
  const result = new Map<string, string>()
  for (const arg of args) {
    if (!arg.startsWith("--") || !arg.includes("=")) throw new Error(`Invalid argument: ${arg}`)
    const [key, ...rest] = arg.slice(2).split("=")
    if (result.has(key)) throw new Error(`Duplicate --${key}`)
    result.set(key, rest.join("="))
  }
  return result
}

function required(args: Map<string, string>, key: string) {
  const value = args.get(key)
  if (!value) throw new Error(`Missing --${key}`)
  return value
}

if (import.meta.main) {
  const [command, ...raw] = process.argv.slice(2)
  const args = argumentsMap(raw)
  if (command === "validate") {
    validateBunVersion(Bun.version)
    validateReleaseVersion(required(args, "version"))
    validateReleaseSource(required(args, "repository"), required(args, "ref"))
    releasePlatform({ runner: required(args, "runner"), target: required(args, "target") })
    console.log(stableJson({ version: RELEASE_VERSION, channel: RELEASE_CHANNEL }).trim())
  } else if (command === "package") {
    const result = await createPlatformRelease({
      version: required(args, "version"),
      sourceSha: required(args, "source-sha"),
      runner: required(args, "runner"),
      target: required(args, "target"),
      dist: required(args, "dist"),
      output: required(args, "output"),
      bunVersion: Bun.version,
      bunRevision: Bun.revision,
    })
    console.log(stableJson(result.sidecar).trim())
  } else {
    throw new Error("Usage: release-artifact.ts validate|package --key=value ...")
  }
}
