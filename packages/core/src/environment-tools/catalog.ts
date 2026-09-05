export * as EnvironmentToolsCatalog from "./catalog.js"

import { Effect, Option, Schema } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { Flock } from "@opencode-ai/util/flock"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"

export const filename = "environment-tools.json"

export const Kind = Schema.Literals(["native", "cmd", "batch", "powershell_script", "other"])
export type Kind = typeof Kind.Type

export const Source = Schema.Literals(["resolved", "successful_execution", "user_provided"])
export type Source = typeof Source.Type

export const Entry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  aliases: Schema.Array(Schema.String),
  path: Schema.String,
  kind: Kind,
  launcher: Schema.NullOr(Schema.Literals(["cmd", "pwsh"])),
  capabilities: Schema.Array(Schema.String),
  directExec: Schema.Boolean,
  source: Source,
  discoveredAt: Schema.String,
  lastVerifiedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  status: Schema.Literals(["active", "stale"]),
  identity: Schema.Struct({
    size: Schema.Number,
    modifiedAt: Schema.NullOr(Schema.String),
  }),
  staleReason: Schema.NullOr(Schema.String),
})
export type Entry = typeof Entry.Type

export const Document = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environment: Schema.Struct({ id: Schema.String, os: Schema.String }),
  tools: Schema.Record(Schema.String, Entry),
})
export type Document = typeof Document.Type

export class CatalogError extends Schema.TaggedError<CatalogError>()("EnvironmentToolsCatalog.Error", {
  message: Schema.String,
}) {}

export interface UpsertInput {
  readonly name: string
  readonly path: string
  readonly aliases?: ReadonlyArray<string>
  readonly capabilities?: ReadonlyArray<string>
  readonly source: Source
}

export interface InvalidateInput {
  readonly id: string
  readonly reason: "path_missing" | "replaced" | "user_requested" | "other"
}

export interface Options {
  readonly now?: () => Date
  readonly environmentID?: string
  readonly probe?: (target: string) => Effect.Effect<FileProbe, CatalogError>
}

export type FileProbe =
  | { readonly kind: "file"; readonly identity: Entry["identity"] }
  | { readonly kind: "missing" }
  | { readonly kind: "non_file" }

const fail = (message: string) => new CatalogError({ message })
const executableExtensions = /(?:\.(?:exe|com|cmd|bat|ps1))+$/i

export function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(executableExtensions, "")
}

function validProgramName(value: string) {
  return value === normalizeName(value) && value.length > 0 && value.length <= 128 && !/[\\/*?]/.test(value)
}

function normalizeValues(values: ReadonlyArray<string>, limit: number, labels = false) {
  const result = new Set<string>()
  for (const raw of values) {
    const value = labels
      ? raw
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
      : raw.trim().toLowerCase()
    if (!value) continue
    result.add(value)
    if (result.size === limit) break
  }
  return [...result].sort()
}

function classify(file: string): { kind: Kind; launcher: "cmd" | "pwsh" | null } {
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase()
  if (extension === ".exe" || extension === ".com") return { kind: "native", launcher: null }
  if (extension === ".cmd") return { kind: "cmd", launcher: "cmd" }
  if (extension === ".bat") return { kind: "batch", launcher: "cmd" }
  if (extension === ".ps1") return { kind: "powershell_script", launcher: "pwsh" }
  return { kind: "other", launcher: null }
}

function sorted(tools: Readonly<Record<string, Entry>>) {
  return Object.fromEntries(Object.entries(tools).sort(([left], [right]) => left.localeCompare(right)))
}

function isTimestamp(value: string) {
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export const make = Effect.fn("EnvironmentToolsCatalog.make")(function* (options: Options = {}) {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const file = path.join(global.config, filename)
  const lockDirectory = path.join(global.state, "locks")
  const environmentIDFile = path.join(global.data, "environment-tools", "environment-id")
  const timestamp = () => (options.now ?? (() => new Date()))().toISOString()

  const loadEnvironmentID = Effect.fn("EnvironmentToolsCatalog.loadEnvironmentID")(function* () {
    if (options.environmentID !== undefined) return options.environmentID
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Flock.effect("environment-tools-environment-id", { dir: lockDirectory })
        if (yield* fs.exists(environmentIDFile).pipe(Effect.mapError((error) => fail(error.message)))) {
          const value = yield* fs
            .readFileString(environmentIDFile)
            .pipe(Effect.mapError((error) => fail(error.message)))
          const id = value.trim()
          if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) {
            return yield* Effect.fail(fail("Environment identity file is malformed"))
          }
          return id
        }
        const id = randomUUID()
        const temporary = `${environmentIDFile}.${process.pid}.${randomUUID()}.tmp`
        yield* fs
          .makeDirectory(path.dirname(environmentIDFile), { recursive: true })
          .pipe(Effect.mapError((error) => fail(error.message)))
        yield* fs.writeFileString(temporary, `${id}\n`, { mode: 0o600 }).pipe(
          Effect.flatMap(() => fs.rename(temporary, environmentIDFile)),
          Effect.mapError((error) => fail(error.message)),
          Effect.ensuring(fs.remove(temporary).pipe(Effect.catch(() => Effect.void))),
        )
        return id
      }),
    )
  })

  const currentEnvironment = Effect.fn("EnvironmentToolsCatalog.currentEnvironment")(function* () {
    return { id: yield* loadEnvironmentID(), os: process.platform } as const
  })
  const empty = (environment: Document["environment"]): Document => ({ schemaVersion: 1, environment, tools: {} })

  const decode = (raw: string, environment: Document["environment"]) =>
    Effect.try({
      try: () => Schema.decodeUnknownSync(Document)(JSON.parse(raw)),
      catch: (cause) => fail(`Unable to decode ${filename}: ${String(cause)}`),
    }).pipe(
      Effect.flatMap((document) =>
        document.environment.id === environment.id && document.environment.os === environment.os
          ? Effect.succeed(document)
          : Effect.fail(fail("Catalog environment does not match the current local environment")),
      ),
      Effect.flatMap((document) => {
        for (const [key, entry] of Object.entries(document.tools)) {
          const launch = classify(entry.path)
          const validAliases = normalizeValues(entry.aliases, 20)
          const validCapabilities = normalizeValues(entry.capabilities, 32, true)
          const validTimes =
            isTimestamp(entry.discoveredAt) &&
            isTimestamp(entry.lastVerifiedAt) &&
            (entry.lastUsedAt === null || isTimestamp(entry.lastUsedAt)) &&
            (entry.identity.modifiedAt === null || isTimestamp(entry.identity.modifiedAt))
          const validStatus =
            (entry.status === "active" && entry.staleReason === null) ||
            (entry.status === "stale" && entry.staleReason !== null && entry.staleReason.length <= 128)
          if (
            !validProgramName(key) ||
            key !== entry.name ||
            !validProgramName(entry.name) ||
            entry.id !== `${environment.id}:${key}` ||
            !path.isAbsolute(entry.path) ||
            entry.kind !== launch.kind ||
            entry.launcher !== launch.launcher ||
            entry.directExec !== (launch.kind === "native") ||
            !validTimes ||
            !validStatus ||
            !Number.isFinite(entry.identity.size) ||
            entry.identity.size < 0 ||
            JSON.stringify(entry.aliases) !== JSON.stringify(validAliases) ||
            JSON.stringify(entry.capabilities) !== JSON.stringify(validCapabilities)
          ) {
            return Effect.fail(fail(`Catalog entry ${key} does not satisfy catalog ownership invariants`))
          }
        }
        return Effect.succeed(document)
      }),
    )

  const readWith = Effect.fn("EnvironmentToolsCatalog.readWith")(function* (environment: Document["environment"]) {
    const exists = yield* fs.exists(file).pipe(Effect.mapError((error) => fail(error.message)))
    if (!exists) return empty(environment)
    const raw = yield* fs.readFileString(file).pipe(Effect.mapError((error) => fail(error.message)))
    return yield* decode(raw, environment)
  })

  const read = Effect.fn("EnvironmentToolsCatalog.read")(function* () {
    return yield* readWith(yield* currentEnvironment())
  })

  const write = Effect.fn("EnvironmentToolsCatalog.write")(function* (document: Document) {
    const temporary = `${file}.tmp-${process.pid}`
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.mapError((error) => fail(error.message)))
    return yield* fs
      .writeFileString(temporary, JSON.stringify({ ...document, tools: sorted(document.tools) }, undefined, 2) + "\n", {
        mode: 0o600,
      })
      .pipe(
        Effect.flatMap(() => fs.rename(temporary, file)),
        Effect.mapError((error) => fail(error.message)),
        Effect.ensuring(fs.remove(temporary).pipe(Effect.catch(() => Effect.void))),
      )
  })

  const locked = <A>(effect: Effect.Effect<A, CatalogError>) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Flock.effect("environment-tools-catalog", { dir: lockDirectory })
        return yield* effect
      }),
    )

  const defaultProbe = (target: string): Effect.Effect<FileProbe, CatalogError> =>
    fs.stat(target).pipe(
      Effect.map(
        (info): FileProbe =>
          info.type === "File"
            ? {
                kind: "file",
                identity: {
                  size: Number(info.size),
                  modifiedAt: Option.getOrUndefined(info.mtime)?.toISOString() ?? null,
                },
              }
            : { kind: "non_file" },
      ),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({ kind: "missing" } as const)),
      Effect.mapError((error) => fail(`Unable to inspect environment tool path ${target}: ${error.message}`)),
    )

  const probe = options.probe ?? defaultProbe

  const statIdentity = (target: string) =>
    probe(target).pipe(
      Effect.flatMap((result) => {
        if (result.kind === "file") return Effect.succeed(result.identity)
        if (result.kind === "missing") return Effect.fail(fail(`Environment tool path does not exist: ${target}`))
        return Effect.fail(fail(`Environment tool path is not a regular file: ${target}`))
      }),
    )

  const upsert = Effect.fn("EnvironmentToolsCatalog.upsert")(function* (input: UpsertInput) {
    const name = normalizeName(input.name)
    if (!validProgramName(name)) {
      return yield* Effect.fail(fail("Program name must be a wildcard-free simple name from 1 to 128 characters"))
    }
    if (!path.isAbsolute(input.path)) {
      return yield* Effect.fail(fail(`Environment tool path must be absolute: ${input.path}`))
    }
    if ((input.aliases?.length ?? 0) > 20 || input.aliases?.some((value) => value.trim().length > 128)) {
      return yield* Effect.fail(fail("Aliases are limited to 20 values of at most 128 characters"))
    }
    if ((input.capabilities?.length ?? 0) > 32 || input.capabilities?.some((value) => value.trim().length > 128)) {
      return yield* Effect.fail(fail("Capabilities are limited to 32 values of at most 128 characters"))
    }
    const canonical = yield* fs
      .realPath(input.path)
      .pipe(Effect.mapError(() => fail(`Environment tool path does not exist: ${input.path}`)))
    const identity = yield* statIdentity(canonical)
    const launch = classify(canonical)
    const aliases = normalizeValues([...(input.aliases ?? []), path.basename(canonical)], 20)
    const capabilities = normalizeValues(input.capabilities ?? [], 32, true)
    const environment = yield* currentEnvironment()

    return yield* locked(
      Effect.gen(function* () {
        const document = yield* readWith(environment)
        const previous = document.tools[name]
        const now = timestamp()
        const isSamePath = previous !== undefined && samePath(previous.path, canonical)
        const entry: Entry = {
          id: `${environment.id}:${name}`,
          name,
          aliases: normalizeValues([...(isSamePath ? previous.aliases : []), ...aliases], 20),
          path: canonical,
          kind: launch.kind,
          launcher: launch.launcher,
          capabilities: normalizeValues([...(isSamePath ? previous.capabilities : []), ...capabilities], 32, true),
          directExec: launch.kind === "native",
          source: input.source,
          discoveredAt: isSamePath ? previous.discoveredAt : now,
          lastVerifiedAt: now,
          lastUsedAt: input.source === "successful_execution" ? now : isSamePath ? previous.lastUsedAt : null,
          status: "active",
          identity,
          staleReason: null,
        }
        yield* write({ ...document, tools: { ...document.tools, [name]: entry } })
        return {
          operation: "update" as const,
          result: previous === undefined ? ("created" as const) : ("refreshed" as const),
          entry,
        }
      }),
    )
  })

  const invalidate = Effect.fn("EnvironmentToolsCatalog.invalidate")(function* (input: InvalidateInput) {
    const environment = yield* currentEnvironment()
    return yield* locked(
      Effect.gen(function* () {
        const document = yield* readWith(environment)
        const found = Object.entries(document.tools).find(([, entry]) => entry.id === input.id)
        if (!found) return yield* Effect.fail(fail(`Environment tool entry not found: ${input.id}`))
        const [name, current] = found
        const entry: Entry = { ...current, status: "stale", staleReason: input.reason }
        yield* write({ ...document, tools: { ...document.tools, [name]: entry } })
        return { operation: "update" as const, result: "invalidated" as const, entry }
      }),
    )
  })

  const search = Effect.fn("EnvironmentToolsCatalog.search")(function* (query: string, limit = 5) {
    const needle = query.trim().toLowerCase()
    if (!needle || needle.length > 200) return yield* Effect.fail(fail("Search query must be 1 to 200 characters"))
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      return yield* Effect.fail(fail("Search limit must be an integer from 1 to 20"))
    }
    const document = yield* readWith(yield* currentEnvironment())
    const ranked = Object.values(document.tools)
      .flatMap((entry) => {
        const names = [entry.name, ...entry.aliases]
        const exact = names.includes(needle)
        const prefix = names.some((value) => value.startsWith(needle))
        const capability = entry.capabilities.includes(needle)
        const substring = [...names, ...entry.capabilities, path.basename(entry.path).toLowerCase()].some((value) =>
          value.includes(needle),
        )
        return exact || prefix || capability || substring
          ? [{ entry, score: exact ? 0 : prefix ? 1 : capability ? 2 : 3 }]
          : []
      })
      .sort((left, right) => left.score - right.score || left.entry.name.localeCompare(right.entry.name))
    const selected = ranked.slice(0, limit)
    const matches = yield* Effect.forEach(selected, ({ entry }) =>
      probe(entry.path).pipe(
        Effect.map((result) => {
          if (result.kind === "missing") return { ...entry, exists: false, status: "stale" as const }
          if (result.kind === "non_file") return { ...entry, exists: true, status: "stale" as const }
          return {
            ...entry,
            exists: true,
            status:
              entry.status === "active" &&
              result.identity.size === entry.identity.size &&
              result.identity.modifiedAt === entry.identity.modifiedAt
                ? ("active" as const)
                : ("stale" as const),
          }
        }),
      ),
    )
    return {
      operation: "search" as const,
      query,
      matches,
      truncated: ranked.length > selected.length,
    }
  })

  const listNames = Effect.fn("EnvironmentToolsCatalog.listNames")(function* () {
    const document = yield* readWith(yield* currentEnvironment())
    const names = Object.keys(document.tools).sort((left, right) => left.localeCompare(right))
    return {
      operation: "search" as const,
      mode: "all" as const,
      count: names.length,
      names,
    }
  })

  const resolveExecutable = Effect.fn("EnvironmentToolsCatalog.resolveExecutable")(function* (id: string) {
    const value = id.trim()
    if (!value || value.length > 256) return yield* Effect.fail(fail("Catalog entry id must be 1 to 256 characters"))
    const document = yield* readWith(yield* currentEnvironment())
    const entry = Object.values(document.tools).find((candidate) => candidate.id === value)
    if (!entry) return yield* Effect.fail(fail(`No environment tool has catalog id: ${value}`))
    if (entry.status !== "active") {
      return yield* Effect.fail(fail(`Environment tool is not active: ${entry.name}`))
    }
    if (!entry.directExec || entry.kind !== "native" || entry.launcher !== null) {
      return yield* Effect.fail(fail(`Environment tool is not eligible for direct execution: ${entry.name}`))
    }
    const inspected = yield* probe(entry.path)
    if (inspected.kind === "missing") {
      return yield* Effect.fail(fail(`Environment tool path does not exist: ${entry.path}`))
    }
    if (inspected.kind === "non_file") {
      return yield* Effect.fail(fail(`Environment tool path is not a regular file: ${entry.path}`))
    }
    if (
      inspected.identity.size !== entry.identity.size ||
      inspected.identity.modifiedAt !== entry.identity.modifiedAt ||
      classify(entry.path).kind !== "native"
    ) {
      return yield* Effect.fail(fail(`Environment tool changed after it was cataloged: ${entry.name}`))
    }
    return entry
  })

  return { file, read, search, listNames, resolveExecutable, upsert, invalidate } as const
})
