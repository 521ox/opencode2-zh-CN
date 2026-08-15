export * as SessionStartDirectory from "./start-directory.js"

import path from "path"
import { AbsolutePath } from "../schema.js"

export function platform(input: string) {
  if (/^[A-Za-z]:[\\/]/.test(input)) return path.win32
  if (/^[A-Za-z]:/.test(input)) return
  if (/^[\\/]{2}/.test(input)) {
    if (!/^[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/].*)?$/.test(input)) return
    return path.win32
  }
  if (input.startsWith("\\")) return
  if (input.startsWith("/") && !input.startsWith("//")) return path.posix
}

/** Validates a persisted Session creation directory without consulting the filesystem. */
export function validate(input: unknown): AbsolutePath | undefined {
  if (typeof input !== "string" || input.length === 0 || /[\u0000-\u001f\u007f]/.test(input)) return
  const selected = platform(input)
  if (!selected?.isAbsolute(input)) return
  const directory = selected.resolve(input)
  const root = selected.parse(directory).root
  const comparable = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase()
  if (!root || comparable(directory) === comparable(root)) return
  return AbsolutePath.make(directory)
}

/** Converts a valid path to the cross-platform database representation. */
export function storage(input: unknown) {
  const directory = validate(input)
  if (!directory) return
  return platform(directory) === path.win32 ? directory.replaceAll("\\", "/") : directory
}
