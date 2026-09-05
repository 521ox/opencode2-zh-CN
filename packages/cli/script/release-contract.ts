import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { gzipSync } from "node:zlib"

export const RELEASE_VERSION = "1.18.4-zhcn.1"
export const RELEASE_TAG = `v${RELEASE_VERSION}`
export const RELEASE_CHANNEL = "zh-cn"
export const RELEASE_BUN_VERSION = "1.3.14"
export const RELEASE_REPOSITORY = "521ox/opencode2-zh-CN"
export const RELEASE_REF = "refs/heads/main"

export type ReleasePlatform = {
  readonly runner: string
  readonly target: string
  readonly distDirectory: string
  readonly archive: string
  readonly format: "zip" | "tar.gz"
  readonly executable: string
}

export const RELEASE_PLATFORMS: readonly ReleasePlatform[] = [
  {
    runner: "windows-2025",
    target: "opencode2-windows-x64",
    distDirectory: "cli-windows-x64",
    archive: "opencode2-windows-x64.zip",
    format: "zip",
    executable: "bin/opencode2.exe",
  },
  {
    runner: "windows-11-arm",
    target: "opencode2-windows-arm64",
    distDirectory: "cli-windows-arm64",
    archive: "opencode2-windows-arm64.zip",
    format: "zip",
    executable: "bin/opencode2.exe",
  },
  {
    runner: "ubuntu-24.04",
    target: "opencode2-linux-x64",
    distDirectory: "cli-linux-x64",
    archive: "opencode2-linux-x64.tar.gz",
    format: "tar.gz",
    executable: "bin/opencode2",
  },
  {
    runner: "ubuntu-24.04-arm",
    target: "opencode2-linux-arm64",
    distDirectory: "cli-linux-arm64",
    archive: "opencode2-linux-arm64.tar.gz",
    format: "tar.gz",
    executable: "bin/opencode2",
  },
  {
    runner: "macos-15-intel",
    target: "opencode2-darwin-x64",
    distDirectory: "cli-darwin-x64",
    archive: "opencode2-darwin-x64.tar.gz",
    format: "tar.gz",
    executable: "bin/opencode2",
  },
  {
    runner: "macos-15",
    target: "opencode2-darwin-arm64",
    distDirectory: "cli-darwin-arm64",
    archive: "opencode2-darwin-arm64.tar.gz",
    format: "tar.gz",
    executable: "bin/opencode2",
  },
] as const

export type ReleaseSidecar = {
  readonly schemaVersion: 1
  readonly sourceSha: string
  readonly version: string
  readonly channel: string
  readonly bun: { readonly version: string; readonly revision: string }
  readonly runner: string
  readonly target: string
  readonly distDirectory: string
  readonly archive: { readonly name: string; readonly bytes: number; readonly sha256: string }
  readonly executable: { readonly path: string; readonly bytes: number; readonly sha256: string }
  readonly unsigned: true
}

export type ReleaseManifest = {
  readonly schemaVersion: 1
  readonly repository: string
  readonly tag: string
  readonly sourceSha: string
  readonly version: string
  readonly channel: string
  readonly prerelease: true
  readonly unsigned: true
  readonly platforms: readonly (ReleaseSidecar & { readonly sidecar: { readonly name: string; readonly sha256: string } })[]
}

export function validateReleaseVersion(value: string) {
  if (value !== RELEASE_VERSION) {
    throw new Error(`This first-release workflow only accepts version ${RELEASE_VERSION}`)
  }
  return value
}

export function validateBunVersion(value: string) {
  if (value !== RELEASE_BUN_VERSION) throw new Error(`Release tooling requires Bun ${RELEASE_BUN_VERSION}`)
  return value
}

export function validateReleaseSource(repository: string, ref: string) {
  if (repository !== RELEASE_REPOSITORY) {
    throw new Error(`Release workflow must run in ${RELEASE_REPOSITORY}`)
  }
  if (ref !== RELEASE_REF) throw new Error(`Release workflow must run from ${RELEASE_REF}`)
  return { repository, ref }
}

export function releasePlatform(input: { runner: string; target: string; distDirectory?: string }) {
  const platform = RELEASE_PLATFORMS.find((item) => item.runner === input.runner && item.target === input.target)
  if (!platform) throw new Error(`Invalid native runner/target pair: ${input.runner}/${input.target}`)
  if (input.distDirectory !== undefined && input.distDirectory !== platform.distDirectory) {
    throw new Error(`Dist directory mismatch for ${input.target}: ${input.distDirectory}`)
  }
  return platform
}

export async function createReleaseArchive(platform: ReleasePlatform, dist: string, destination: string) {
  const root = path.resolve(dist)
  if (!(await stat(root)).isDirectory()) throw new Error(`Release dist is not a directory: ${root}`)
  if (path.basename(root) !== platform.distDirectory) {
    throw new Error(`Release dist basename must be ${platform.distDirectory}: ${root}`)
  }
  const entries = await archiveEntries(root, platform.distDirectory, platform.executable)
  const body = platform.format === "zip" ? zip(entries) : deterministicGzip(tar(entries))
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, body)
  return body
}

export function sha256(body: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex")
}

export function stableJson(value: unknown) {
  return JSON.stringify(value, null, 2) + "\n"
}

export async function writeStableJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, stableJson(value))
}

type ArchiveEntry = { readonly name: string; readonly directory: boolean; readonly mode: number; readonly body: Buffer }

async function archiveEntries(root: string, archiveRoot: string, executable: string) {
  const result: ArchiveEntry[] = [{ name: `${archiveRoot}/`, directory: true, mode: 0o755, body: Buffer.alloc(0) }]
  async function visit(directory: string, relative: string) {
    const names = (await readdir(directory)).toSorted()
    for (const name of names) {
      const absolute = path.join(directory, name)
      const child = relative ? `${relative}/${name}` : name
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`Release dist must not contain symbolic links: ${absolute}`)
      if (info.isDirectory()) {
        result.push({ name: `${archiveRoot}/${child}/`, directory: true, mode: 0o755, body: Buffer.alloc(0) })
        await visit(absolute, child)
        continue
      }
      if (!info.isFile()) throw new Error(`Unsupported release dist entry: ${absolute}`)
      result.push({
        name: `${archiveRoot}/${child}`,
        directory: false,
        mode: child === executable ? 0o755 : 0o644,
        body: await readFile(absolute),
      })
    }
  }
  await visit(root, "")
  return result
}

function tar(entries: readonly ArchiveEntry[]) {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    writeTarString(header, 0, 100, entry.name)
    writeTarOctal(header, 100, 8, entry.mode)
    writeTarOctal(header, 108, 8, 0)
    writeTarOctal(header, 116, 8, 0)
    writeTarOctal(header, 124, 12, entry.body.byteLength)
    writeTarOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = entry.directory ? 0x35 : 0x30
    writeTarString(header, 257, 6, "ustar")
    writeTarFixed(header, 263, 2, "00")
    writeTarString(header, 265, 32, "root")
    writeTarString(header, 297, 32, "root")
    writeTarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0))
    blocks.push(header, entry.body)
    const remainder = entry.body.byteLength % 512
    if (remainder) blocks.push(Buffer.alloc(512 - remainder))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function deterministicGzip(body: Uint8Array) {
  const compressed = gzipSync(body, { level: 9 })
  compressed.writeUInt32LE(0, 4)
  compressed[9] = 0xff
  return compressed
}

function writeTarString(target: Buffer, offset: number, width: number, value: string) {
  const body = Buffer.from(value)
  if (body.byteLength >= width) throw new Error(`Archive path or field is too long: ${value}`)
  body.copy(target, offset)
}

function writeTarFixed(target: Buffer, offset: number, width: number, value: string) {
  const body = Buffer.from(value)
  if (body.byteLength !== width) throw new Error(`Archive fixed-width field must be exactly ${width} bytes: ${value}`)
  body.copy(target, offset)
}

function writeTarOctal(target: Buffer, offset: number, width: number, value: number) {
  const body = value.toString(8).padStart(width - 2, "0") + "\0 "
  target.write(body, offset, width, "ascii")
}

function zip(entries: readonly ArchiveEntry[]) {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const checksum = crc32(entry.body)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(0x21, 12)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(entry.body.byteLength, 18)
    header.writeUInt32LE(entry.body.byteLength, 22)
    header.writeUInt16LE(name.byteLength, 26)
    local.push(header, name, entry.body)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(0x0314, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0x800, 8)
    directory.writeUInt16LE(0x21, 14)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(entry.body.byteLength, 20)
    directory.writeUInt32LE(entry.body.byteLength, 24)
    directory.writeUInt16LE(name.byteLength, 28)
    const unixMode = entry.mode | (entry.directory ? 0o040000 : 0o100000)
    directory.writeUInt32LE(((unixMode << 16) | (entry.directory ? 0x10 : 0)) >>> 0, 38)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, name)
    offset += header.byteLength + name.byteLength + entry.body.byteLength
  }
  const centralBody = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBody.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBody, end])
}

function crc32(body: Uint8Array) {
  let value = 0xffffffff
  for (const byte of body) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  }
  return (value ^ 0xffffffff) >>> 0
}
