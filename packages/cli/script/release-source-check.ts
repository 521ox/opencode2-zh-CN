#!/usr/bin/env bun

import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

export function parseIndexSymlinkPaths(index: string) {
  const result = new Set<string>()
  for (const entry of index.split("\0")) {
    if (!entry) continue
    const separator = entry.indexOf("\t")
    if (separator === -1) throw new Error("Invalid git index entry without a path separator")
    const metadata = entry.slice(0, separator).split(" ")
    if (metadata.length !== 3) throw new Error(`Invalid git index metadata: ${entry.slice(0, separator)}`)
    if (metadata[0] === "120000") result.add(entry.slice(separator + 1))
  }
  return [...result].toSorted()
}

export function assertWorkspaceContainedSymlink(root: string, relative: string, isSymbolicLink: boolean, target?: string) {
  if (!isSymbolicLink) throw new Error(`Tracked symlink was checked out as a regular file: ${relative}`)
  if (!target) throw new Error(`Tracked symlink is dangling: ${relative}`)
  const fromRoot = path.relative(root, target)
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`Tracked symlink resolves outside the workspace: ${relative} -> ${target}`)
  }
}

export async function verifyIndexedSymlinks(root: string, relativePaths: readonly string[]) {
  const workspace = await realpath(root)
  for (const relative of relativePaths) {
    const absolute = path.resolve(workspace, relative)
    const location = path.relative(workspace, absolute)
    if (location === ".." || location.startsWith(`..${path.sep}`) || path.isAbsolute(location)) {
      throw new Error(`Tracked symlink path escapes the workspace: ${relative}`)
    }
    const info = await lstat(absolute).catch((cause: unknown) => {
      throw new Error(`Tracked symlink is missing: ${relative}`, { cause })
    })
    if (!info.isSymbolicLink()) {
      assertWorkspaceContainedSymlink(workspace, relative, false, absolute)
    }
    const target = await realpath(absolute).catch((cause: unknown) => {
      throw new Error(`Tracked symlink is dangling: ${relative}`, { cause })
    })
    assertWorkspaceContainedSymlink(workspace, relative, true, target)
  }
}

export async function verifyReleaseSource(expected: string, root = process.cwd()) {
  if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error("A full --source-sha is required")
  const head = (await git(root, "rev-parse", "HEAD")).trim()
  if (head !== expected) throw new Error(`Checked-out source mismatch: expected=${expected} actual=${head}`)
  await git(root, "diff", "--exit-code")
  await git(root, "diff", "--cached", "--exit-code")
  const index = await git(root, "ls-files", "--stage", "-z")
  await verifyIndexedSymlinks(root, parseIndexSymlinkPaths(index))
  const untracked = await git(root, "ls-files", "--others", "--exclude-standard")
  if (untracked.trim()) throw new Error(`Unexpected untracked source files:\n${untracked}`)

  const ignored = (await git(root, "status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all"))
    .split(/\r?\n/)
    .filter(Boolean)
  for (const line of ignored) {
    if (!line.startsWith("!! ")) throw new Error(`Source tree changed: ${line}`)
    const name = line.slice(3).replaceAll("\\", "/")
    const allowed =
      name === "node_modules/" ||
      name.includes("/node_modules/") ||
      name === "packages/app/dist/" ||
      name.startsWith("packages/app/dist/") ||
      name === "packages/cli/dist/" ||
      name.startsWith("packages/cli/dist/")
    if (!allowed) throw new Error(`Unexpected ignored output: ${name}`)
  }
  console.log(`Verified clean audited release source ${expected}`)
}

async function git(root: string, ...args: string[]) {
  const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`)
  return stdout
}

if (import.meta.main) {
  const expected = process.argv.find((value) => value.startsWith("--source-sha="))?.slice("--source-sha=".length)
  if (!expected) throw new Error("A full --source-sha is required")
  await verifyReleaseSource(expected)
}
