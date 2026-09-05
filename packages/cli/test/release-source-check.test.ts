import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  assertWorkspaceContainedSymlink,
  parseIndexSymlinkPaths,
  verifyIndexedSymlinks,
} from "../script/release-source-check"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("release source symlink integrity", () => {
  test("parses only deduplicated mode-120000 index paths", () => {
    const index = [
      `100644 ${"a".repeat(40)} 0\tREADME.md`,
      `120000 ${"b".repeat(40)} 0\tpackages/app/src/custom-elements.d.ts`,
      `120000 ${"c".repeat(40)} 0\tpackages/app/public/icon.svg`,
      `120000 ${"c".repeat(40)} 0\tpackages/app/public/icon.svg`,
      "",
    ].join("\0")
    expect(parseIndexSymlinkPaths(index)).toEqual([
      "packages/app/public/icon.svg",
      "packages/app/src/custom-elements.d.ts",
    ])
  })

  test("rejects an index-declared symlink checked out as a regular file", async () => {
    const root = await temporaryRoot()
    await writeFile(path.join(root, "fake-link"), "../target")
    await expect(verifyIndexedSymlinks(root, ["fake-link"])).rejects.toThrow(
      "Tracked symlink was checked out as a regular file",
    )
  })

  test("accepts a contained real symlink, with pure-owner coverage if creation is unavailable", async () => {
    const root = await temporaryRoot()
    const target = path.join(root, "target.txt")
    await writeFile(target, "target")
    try {
      await symlink("target.txt", path.join(root, "link.txt"), "file")
      await expect(verifyIndexedSymlinks(root, ["link.txt"])).resolves.toBeUndefined()
    } catch (cause) {
      if (!isSymlinkPrivilegeError(cause)) throw cause
      expect(() => assertWorkspaceContainedSymlink(root, "link.txt", true, target)).not.toThrow()
    }
  })

  test("rejects dangling and workspace-external symlink targets", async () => {
    const root = await temporaryRoot()
    expect(() => assertWorkspaceContainedSymlink(root, "dangling", true)).toThrow("Tracked symlink is dangling")
    expect(() => assertWorkspaceContainedSymlink(root, "external", true, path.resolve(root, "..", "outside"))).toThrow(
      "resolves outside the workspace",
    )
    expect(() => assertWorkspaceContainedSymlink(root, "fake", false, path.join(root, "target"))).toThrow(
      "checked out as a regular file",
    )
  })
})

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-release-source-check-"))
  roots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

function isSymlinkPrivilegeError(cause: unknown) {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return false
  return cause.code === "EPERM" || cause.code === "EACCES" || cause.code === "UNKNOWN"
}
