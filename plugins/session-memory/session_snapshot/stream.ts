import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import { canonicalJSON, canonicalPrettyJSON } from "./canonical"
import { verifyOwnedSnapshotRoot, type OwnedSnapshotRoot } from "./owned-root"
import type { PrivacyController } from "./privacy"

export type StreamFileSummary = {
  sha256: string
  total_bytes: number
  total_lines: number
  carriage_return_count: number
  trailing_lf_count: number
}

export type StreamHashSummary = {
  sha256: string
  total_bytes: number
}

const STREAM_BUFFER_BYTES = 512 * 1024

export async function writeAllBytes(
  buffer: Uint8Array,
  writeChunk: (offset: number, length: number) => Promise<number>,
  label = "snapshot stream",
): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const bytesWritten = await writeChunk(offset, buffer.length - offset)
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - offset) {
      throw new Error(`${label} made invalid write progress`)
    }
    offset += bytesWritten
  }
}

export class ProtectedStreamWriter {
  private readonly hash = createHash("sha256")
  private bytes = 0
  private newlines = 0
  private carriageReturns = 0
  private trailingLFs = 0
  private endsWithLF = false
  private closed = false
  private pending: Buffer[] = []
  private pendingBytes = 0
  private activeWrite: Promise<void> | null = null
  private activeWriteError: unknown

  private constructor(
    private readonly handle: fs.FileHandle,
    readonly path: string,
    private readonly privacy: PrivacyController,
  ) {}

  static async open(
    ownedRoot: OwnedSnapshotRoot,
    target: string,
    privacy: PrivacyController,
    options: { secure?: boolean } = {},
  ): Promise<ProtectedStreamWriter> {
    await verifyOwnedSnapshotRoot(ownedRoot, privacy)
    const handle = await fs.open(target, "wx", 0o600)
    try {
      if (options.secure !== false) {
        await privacy.secureFile(target)
        await privacy.verifyFile(target)
      }
      return new ProtectedStreamWriter(handle, target, privacy)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await fs.rm(target, { force: true }).catch(() => undefined)
      throw error
    }
  }

  get currentLine(): number {
    return this.bytes === 0 ? 1 : this.newlines + 1
  }

  get totalBytes(): number {
    return this.bytes
  }

  private async writeBuffer(buffer: Buffer): Promise<void> {
    await writeAllBytes(
      buffer,
      async (offset, length) => (await this.handle.write(buffer, offset, length, null)).bytesWritten,
      `Snapshot stream ${this.path}`,
    )
  }

  private async settleActiveWrite(): Promise<void> {
    if (this.activeWrite) {
      await this.activeWrite
      this.activeWrite = null
    }
    if (this.activeWriteError) {
      const error = this.activeWriteError
      this.activeWriteError = undefined
      throw error
    }
  }

  private async queueBuffer(buffer: Buffer): Promise<void> {
    await this.settleActiveWrite()
    this.activeWrite = this.writeBuffer(buffer).catch((error) => {
      this.activeWriteError ??= error
    })
  }

  private async flush(): Promise<void> {
    if (this.pendingBytes === 0) return
    const pending = this.pending
    const pendingBytes = this.pendingBytes
    this.pending = []
    this.pendingBytes = 0
    await this.queueBuffer(Buffer.concat(pending, pendingBytes))
  }

  private async writeLargeBuffer(buffer: Buffer): Promise<void> {
    await this.flush()
    await this.settleActiveWrite()
    await this.writeBuffer(buffer)
  }

  private observe(buffer: Buffer): void {
    this.hash.update(buffer)
    this.bytes += buffer.length
    for (const byte of buffer) {
      if (byte === 10) {
        this.newlines++
        this.trailingLFs++
      } else {
        this.trailingLFs = 0
        if (byte === 13) this.carriageReturns++
      }
    }
    if (buffer.length > 0) this.endsWithLF = buffer.at(-1) === 10
  }

  write(input: string | Uint8Array): Promise<void> | void {
    if (this.closed) throw new Error(`Cannot write to a closed snapshot stream: ${this.path}`)
    const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input)
    this.observe(buffer)
    if (buffer.length >= STREAM_BUFFER_BYTES) {
      return this.writeLargeBuffer(buffer)
    }
    this.pending.push(buffer)
    this.pendingBytes += buffer.length
    if (this.pendingBytes >= STREAM_BUFFER_BYTES) return this.flush()
  }

  async copyFrom(sourcePath: string, chunkBytes = STREAM_BUFFER_BYTES): Promise<void> {
    const source = await fs.open(sourcePath, "r")
    const buffers = [Buffer.allocUnsafe(chunkBytes), Buffer.allocUnsafe(chunkBytes)]
    let bufferIndex = 0
    try {
      await this.flush()
      await this.settleActiveWrite()
      while (true) {
        const buffer = buffers[bufferIndex]
        const result = await source.read(buffer, 0, buffer.length, null)
        if (result.bytesRead === 0) break
        const chunk = buffer.subarray(0, result.bytesRead)
        this.observe(chunk)
        await this.queueBuffer(chunk)
        bufferIndex = (bufferIndex + 1) % buffers.length
      }
    } finally {
      await source.close()
    }
  }

  async finish(options: { requireTrailingLF: boolean; durable?: boolean; verifyPrivacy?: boolean }): Promise<StreamFileSummary> {
    if (this.closed) throw new Error(`Snapshot stream is already closed: ${this.path}`)
    if (options.requireTrailingLF && this.bytes > 0 && !this.endsWithLF) {
      throw new Error(`Snapshot stream must end with one LF: ${this.path}`)
    }
    this.closed = true
    try {
      await this.flush()
      await this.settleActiveWrite()
      if (options.durable !== false) await this.handle.sync()
    } finally {
      await this.handle.close()
    }
    if (options.verifyPrivacy !== false) await this.privacy.verifyFile(this.path)
    return {
      sha256: this.hash.digest("hex"),
      total_bytes: this.bytes,
      total_lines: this.bytes === 0 ? 0 : this.newlines + (this.endsWithLF ? 0 : 1),
      carriage_return_count: this.carriageReturns,
      trailing_lf_count: this.trailingLFs,
    }
  }

  async abort(): Promise<void> {
    this.pending = []
    this.pendingBytes = 0
    if (this.activeWrite) await this.activeWrite.catch(() => undefined)
    this.activeWrite = null
    this.activeWriteError = undefined
    if (!this.closed) {
      this.closed = true
      await this.handle.close().catch(() => undefined)
    }
    await fs.rm(this.path, { force: true }).catch(() => undefined)
  }
}

export async function inspectStreamFile(target: string): Promise<StreamFileSummary> {
  const handle = await fs.open(target, "r")
  const hash = createHash("sha256")
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const buffer = Buffer.allocUnsafe(256 * 1024)
  const prefix: number[] = []
  let totalBytes = 0
  let newlines = 0
  let endsWithLF = false
  let carriageReturns = 0
  let trailingLFs = 0
  try {
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null)
      if (result.bytesRead === 0) break
      const chunk = buffer.subarray(0, result.bytesRead)
      for (const byte of chunk) {
        if (prefix.length === 3) break
        prefix.push(byte)
      }
      try {
        decoder.decode(chunk, { stream: true })
      } catch (error) {
        throw new Error(`Snapshot file is not valid UTF-8: ${target}`, { cause: error })
      }
      hash.update(chunk)
      totalBytes += chunk.length
      for (const byte of chunk) {
        if (byte === 10) {
          newlines++
          trailingLFs++
        } else {
          trailingLFs = 0
          if (byte === 13) carriageReturns++
        }
      }
      endsWithLF = chunk.at(-1) === 10
    }
    try {
      decoder.decode()
    } catch (error) {
      throw new Error(`Snapshot file is not valid UTF-8: ${target}`, { cause: error })
    }
  } finally {
    await handle.close()
  }
  if (prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) {
    throw new Error(`Snapshot file must not contain a UTF-8 BOM: ${target}`)
  }
  return {
    sha256: hash.digest("hex"),
    total_bytes: totalBytes,
    total_lines: totalBytes === 0 ? 0 : newlines + (endsWithLF ? 0 : 1),
    carriage_return_count: carriageReturns,
    trailing_lf_count: trailingLFs,
  }
}

export async function hashStreamFile(target: string): Promise<StreamHashSummary> {
  const handle = await fs.open(target, "r")
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let totalBytes = 0
  try {
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null)
      if (result.bytesRead === 0) break
      const chunk = buffer.subarray(0, result.bytesRead)
      hash.update(chunk)
      totalBytes += chunk.length
    }
  } finally {
    await handle.close()
  }
  return { sha256: hash.digest("hex"), total_bytes: totalBytes }
}

export function canonicalProperty(name: string, value: unknown, trailingComma: boolean): string {
  const lines = canonicalPrettyJSON(value).slice(0, -1).split("\n")
  const first = lines[0]
  if (first === undefined) throw new Error(`Canonical property ${name} is empty`)
  const output = [`  ${JSON.stringify(name)}: ${first}`, ...lines.slice(1).map((line) => `  ${line}`)]
  if (trailingComma) output[output.length - 1] = `${output.at(-1)},`
  return `${output.join("\n")}\n`
}

export function canonicalCompactArrayItem(value: unknown): string {
  return `    ${canonicalJSON(value)}`
}

export function uniqueTemporaryFile(target: string, label: string): string {
  return `${target}.${label}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
}
