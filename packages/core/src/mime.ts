export * as Mime from "./mime.js"

import { Effect, FileSystem, Option } from "effect"
import { fileURLToPath } from "url"
import { FSUtil } from "./fs-util"

const SAMPLE_BYTES = 8192

export const resolve = Effect.fn("Mime.resolve")(function* (uri: string) {
  const data = dataSample(uri)
  if (data) return detect(data)

  const target = yield* Effect.try({
    try: () => localPath(uri),
    catch: () => new Error("Invalid file URI"),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!target) return "application/octet-stream"

  const fs = yield* FSUtil.Service
  const local = yield* Effect.scoped(
    Effect.gen(function* () {
      const info = yield* fs.stat(target)
      if (info.type === "Directory") return { type: "directory" as const }
      if (info.type !== "File") return
      const file = yield* fs.open(target)
      return {
        type: "file" as const,
        sample: Option.getOrElse(yield* file.readAlloc(FileSystem.Size(SAMPLE_BYTES)), () => new Uint8Array()),
      }
    }),
  ).pipe(Effect.catch(() => Effect.succeed(undefined)))

  if (local?.type === "directory") return "application/x-directory"
  if (local?.type === "file") return detect(local.sample)
  return "application/octet-stream"
})

function detect(bytes: Uint8Array) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
  if (
    startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70]) &&
    (startsWith(bytes.subarray(8), [0x61, 0x76, 0x69, 0x66]) ||
      startsWith(bytes.subarray(8), [0x61, 0x76, 0x69, 0x73]))
  )
    return "image/avif"
  return isText(bytes) ? "text/plain" : "application/octet-stream"
}

function dataSample(uri: string) {
  if (!uri.startsWith("data:")) return
  const comma = uri.indexOf(",")
  if (comma === -1) return new Uint8Array()
  const metadata = uri.slice(5, comma)
  const payload = uri.slice(comma + 1)
  if (metadata.split(";").some((part) => part.toLowerCase() === "base64")) {
    return Buffer.from(payload.slice(0, Math.ceil((SAMPLE_BYTES * 4) / 3) + 4), "base64").subarray(0, SAMPLE_BYTES)
  }
  return new TextEncoder().encode(payload.slice(0, SAMPLE_BYTES))
}

function localPath(uri: string) {
  if (!URL.canParse(uri)) return
  const url = new URL(uri)
  if (url.protocol !== "file:") return
  return fileURLToPath(url)
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

function isText(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })
  } catch {
    return false
  }
  const controls = bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0)
  return controls / bytes.length <= 0.3
}
