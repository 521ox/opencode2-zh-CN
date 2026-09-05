import fs from "node:fs/promises"
import path from "node:path"
import type { OpenCodePaths } from "./paths"
import type { PrivacyController } from "./privacy"

type DirectoryIdentity = {
  lexicalPath: string
  realPath: string
  dev: number
  ino: number
}

export type OwnedSnapshotRoot = {
  root: string
  components: DirectoryIdentity[]
}

// V1 rejects pre-existing reparse points and revalidates identity before each operation.
// It does not claim protection from an actively racing process that already owns the same OS user identity.

function assertContained(root: string, target: string, label: string): void {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the approved temporary base`)
  }
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export async function prepareOwnedSnapshotRoot(
  paths: OpenCodePaths,
  privacy: PrivacyController,
  options: { create: boolean },
): Promise<OwnedSnapshotRoot | null> {
  const approvedLexical = path.resolve(paths.approvedTempBase)
  const approvedStats = await fs.lstat(approvedLexical)
  if (!approvedStats.isDirectory()) throw new Error("Approved temporary base is not a directory")
  const approvedReal = await fs.realpath(approvedLexical)
  const targetLexical = path.resolve(paths.snapshotRoot)
  assertContained(approvedLexical, targetLexical, "Snapshot root")
  const relative = path.relative(approvedLexical, targetLexical)
  const components: DirectoryIdentity[] = []
  let current = approvedLexical
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    let stats = await lstatOrNull(current)
    if (!stats) {
      if (!options.create) return null
      try {
        await fs.mkdir(current, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      stats = await fs.lstat(current)
    }
    if (stats.isSymbolicLink()) throw new Error(`Owned temporary directory is a symbolic link or reparse point: ${current}`)
    if (!stats.isDirectory()) throw new Error(`Owned temporary path is not a directory: ${current}`)
    const real = await fs.realpath(current)
    assertContained(approvedReal, real, "Resolved snapshot root")
    await privacy.secureDirectory(real)
    await privacy.verifyDirectory(real)
    const secured = await fs.lstat(current)
    components.push({ lexicalPath: current, realPath: real, dev: secured.dev, ino: secured.ino })
  }
  const root = components.at(-1)?.realPath
  if (!root) throw new Error("Snapshot root must be below the approved temporary base")
  return { root, components }
}

export async function verifyOwnedSnapshotRoot(root: OwnedSnapshotRoot, privacy: PrivacyController): Promise<void> {
  for (const component of root.components) {
    const stats = await fs.lstat(component.lexicalPath)
    if (stats.isSymbolicLink()) throw new Error(`Owned temporary directory became a symbolic link or reparse point: ${component.lexicalPath}`)
    if (!stats.isDirectory() || stats.dev !== component.dev || stats.ino !== component.ino) {
      throw new Error(`Owned temporary directory identity changed: ${component.lexicalPath}`)
    }
    const real = await fs.realpath(component.lexicalPath)
    if (real !== component.realPath) throw new Error(`Owned temporary directory target changed: ${component.lexicalPath}`)
    await privacy.verifyDirectory(real)
  }
}
