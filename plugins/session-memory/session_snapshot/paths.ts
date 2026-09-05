import os from "node:os"
import path from "node:path"

export type OpenCodePaths = {
  databasePath: string
  approvedTempBase: string
  snapshotRoot: string
}

export function resolveOpenCodePaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
  tempDirectory = os.tmpdir(),
  channel = env.OPENCODE_CHANNEL || "latest",
): OpenCodePaths {
  const dataHome = env.XDG_DATA_HOME || path.join(homeDirectory, ".local", "share")
  const dataRoot = path.join(dataHome, "opencode")
  const approvedTempBase = path.resolve(tempDirectory)
  const normalizedChannel = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
  const databaseName =
    env.OPENCODE_DB ||
    (["latest", "beta", "next", "prod"].includes(channel) ? "opencode.db" : `opencode-${normalizedChannel}.db`)
  return {
    databasePath: path.isAbsolute(databaseName) ? databaseName : path.join(dataRoot, databaseName),
    approvedTempBase,
    snapshotRoot: path.join(approvedTempBase, "opencode-session-snapshots"),
  }
}

export function assertSessionID(sessionID: string): string {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionID)) throw new Error(`Invalid trusted session ID: ${sessionID}`)
  return sessionID
}

export const SNAPSHOT_FILE_NAME = "snapshot.json"
export const SNAPSHOT_NAVIGATION_FILE_NAME = "navigation.json"

export function snapshotDirectoryPath(snapshotRoot: string, sessionID: string): string {
  const root = path.resolve(snapshotRoot)
  const target = path.resolve(root, assertSessionID(sessionID))
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Snapshot path escapes the owned temporary directory")
  }
  return target
}

export function snapshotBundlePaths(snapshotRoot: string, sessionID: string) {
  const directory = snapshotDirectoryPath(snapshotRoot, sessionID)
  return {
    directory,
    snapshot: path.join(directory, SNAPSHOT_FILE_NAME),
    navigation: path.join(directory, SNAPSHOT_NAVIGATION_FILE_NAME),
  }
}

export function legacySnapshotFilePath(snapshotRoot: string, sessionID: string): string {
  const root = path.resolve(snapshotRoot)
  return path.join(root, `${assertSessionID(sessionID)}.json`)
}

export function isOwnedSnapshotWorkDirectoryName(name: string, sessionID: string): boolean {
  const prefix = `${assertSessionID(sessionID)}.bundle.`
  return name.startsWith(prefix) && (
    name.endsWith(".tmp") ||
    name.endsWith(".bak") ||
    name.endsWith(".failed")
  )
}

export function isOwnedSnapshotLockWorkDirectoryName(name: string, sessionID: string): boolean {
  const prefix = `${assertSessionID(sessionID)}.lock.released.`
  const token = name.slice(prefix.length)
  return name.startsWith(prefix) && /^[a-f0-9]{32}$/.test(token)
}
