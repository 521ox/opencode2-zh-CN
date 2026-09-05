export * as Host from "./host.js"

import path from "node:path"

export interface RuntimeImport {
  readonly importModule: (specifier: string) => Promise<unknown>
  readonly resolveModule: (specifier: string, directory: string) => string
}

export interface Target {
  readonly directory: string
  readonly name?: string
}

export interface Entrypoints {
  readonly server?: string
  readonly tui?: string
  readonly rpc?: string
}

const missingResolutionCodes = new Set([
  "ENOENT",
  "ENOTDIR",
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_UNSUPPORTED_DIR_IMPORT",
])

function isMissingResolution(error: unknown) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null || !("code" in error)) return false
  return typeof error.code === "string" && missingResolutionCodes.has(error.code)
}

export function resolve(target: Target, runtime: Pick<RuntimeImport, "resolveModule">): Entrypoints {
  const entry = (subpaths: readonly string[]) => {
    for (const subpath of subpaths) {
      const specifier = target.name
        ? [target.name, subpath].filter(Boolean).join("/")
        : path.resolve(target.directory, subpath || "index")
      try {
        return runtime.resolveModule(specifier, target.directory)
      } catch (error) {
        if (!isMissingResolution(error)) throw error
      }
    }
    return undefined
  }
  return { server: entry(["server", ""]), tui: entry(["tui"]), rpc: entry(["rpc"]) }
}

export function load(entrypoint: string, runtime: Pick<RuntimeImport, "importModule">): Promise<unknown> {
  return runtime.importModule(entrypoint)
}
