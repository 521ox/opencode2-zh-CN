import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Effect, Layer, Schema } from "effect"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EnvironmentToolsCatalog } from "../src/environment-tools/catalog.js"
import { Permission } from "../src/permission.js"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"

const root = await mkdtemp(path.join(tmpdir(), "opencode-environment-tools-"))

const layer = () =>
  Layer.mergeAll(
    Global.layerWith({
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      tmp: path.join(root, "tmp"),
    }),
    FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer)),
  )

const run = <A, E>(effect: Effect.Effect<A, E, FSUtil.Service | Global.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer())))

const executable = async (folder: string, name: string, content = name) => {
  const directory = path.join(root, folder)
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, name)
  await writeFile(file, content)
  return file
}

beforeEach(async () => {
  await rm(path.join(root, "config"), { recursive: true, force: true })
  await rm(path.join(root, "state"), { recursive: true, force: true })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("environment tools catalog", () => {
  test("search returns an empty result before the catalog exists", async () => {
    const result = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        return yield* catalog.search("git")
      }),
    )

    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(false)
  })

  test("persists one opaque environment identity outside the copyable catalog", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const first = yield* EnvironmentToolsCatalog.make()
        const second = yield* EnvironmentToolsCatalog.make()
        return [(yield* first.read()).environment.id, (yield* second.read()).environment.id]
      }),
    )

    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i)
    expect(ids[0]).not.toBe(`${process.platform}-${process.arch}`)
  })

  test("normalizes chained executable extensions idempotently", async () => {
    expect(EnvironmentToolsCatalog.normalizeName("foo.cmd.exe")).toBe("foo")
    expect(EnvironmentToolsCatalog.normalizeName(EnvironmentToolsCatalog.normalizeName("foo.cmd.exe"))).toBe("foo")
    const firstPath = await executable("chained", "foo.cmd.exe")
    const cmdPath = await executable("chained-cmd", "foo.cmd")
    const plainPath = await executable("chained-plain", "foo")

    const result = await run(
      Effect.gen(function* () {
        const first = yield* EnvironmentToolsCatalog.make()
        const second = yield* EnvironmentToolsCatalog.make()
        const third = yield* EnvironmentToolsCatalog.make()
        yield* first.upsert({ name: "foo.cmd.exe", path: firstPath, source: "resolved" })
        const immediate = {
          document: yield* first.read(),
          search: yield* first.search("foo.cmd.exe"),
        }
        yield* Effect.all(
          [
            first.upsert({ name: "foo.cmd.exe", path: firstPath, source: "resolved" }),
            second.upsert({ name: "foo.cmd", path: cmdPath, source: "resolved" }),
            third.upsert({ name: "foo", path: plainPath, source: "resolved" }),
          ],
          { concurrency: "unbounded" },
        )
        return { immediate, final: yield* first.read() }
      }),
    )

    expect(Object.keys(result.immediate.document.tools)).toEqual(["foo"])
    expect(result.immediate.search.matches).toHaveLength(1)
    expect(Object.keys(result.final.tools)).toEqual(["foo"])
  })

  test("rejects wildcard program names before catalog publication", async () => {
    const git = await executable("wildcard", "git.exe")
    const result = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        const exits = yield* Effect.forEach(["*", "?", "git*", "git?"], (name) =>
          Effect.exit(catalog.upsert({ name, path: git, source: "resolved" })),
        )
        return { exits, file: catalog.file }
      }),
    )

    expect(result.exits.every((exit) => exit._tag === "Failure")).toBe(true)
    expect(await Bun.file(result.file).exists()).toBe(false)
  })

  test("keeps a valid direct-exec saved resource exact", async () => {
    const environmentID = "11111111-1111-4111-8111-111111111111"
    const git = await executable("permission-resource", "git.exe")
    const entry = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make({ environmentID })
        return (yield* catalog.upsert({ name: "git", path: git, source: "resolved" })).entry
      }),
    )
    const saved = [{ action: "direct_exec", resource: entry.id, effect: "allow" as const }]

    expect(Permission.evaluate("direct_exec", entry.id, saved).effect).toBe("allow")
    expect(Permission.evaluate("direct_exec", `${environmentID}:bun`, saved).effect).toBe("ask")
  })

  test("upserts one entry per normalized program name", async () => {
    const firstPath = await executable("first", "git.exe", "first")
    const secondPath = await executable("second", "git.exe", "second")
    let now = new Date("2026-08-17T10:00:00.000Z")

    const result = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make({ now: () => now })
        const created = yield* catalog.upsert({
          name: "Git.exe",
          path: firstPath,
          capabilities: ["version control"],
          source: "resolved",
        })
        now = new Date("2026-08-17T11:00:00.000Z")
        const refreshed = yield* catalog.upsert({
          name: "git",
          path: secondPath,
          aliases: ["GIT.EXE"],
          capabilities: ["version-control"],
          source: "successful_execution",
        })
        return { created, refreshed, document: yield* catalog.read() }
      }),
    )

    expect(result.created.result).toBe("created")
    expect(result.refreshed.result).toBe("refreshed")
    expect(Object.keys(result.document.tools)).toEqual(["git"])
    expect(result.document.tools.git.path).toBe(
      await Bun.file(secondPath)
        .exists()
        .then(() => path.resolve(secondPath)),
    )
    expect(result.document.tools.git.discoveredAt).toBe("2026-08-17T11:00:00.000Z")
    expect(result.document.tools.git.lastUsedAt).toBe("2026-08-17T11:00:00.000Z")
    expect(result.document.tools.git.directExec).toBe(true)
  })

  test("records cmd launchers without native direct-exec eligibility", async () => {
    const npm = await executable("bin", "npm.cmd")
    const entry = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        return (yield* catalog.upsert({ name: "npm", path: npm, source: "resolved" })).entry
      }),
    )

    expect(entry.kind).toBe("cmd")
    expect(entry.launcher).toBe("cmd")
    expect(entry.directExec).toBe(false)
  })

  test.each([
    ["tool.exe", "native", null, true],
    ["tool.com", "native", null, true],
    ["tool.bat", "batch", "cmd", false],
    ["tool.ps1", "powershell_script", "pwsh", false],
    ["tool.bin", "other", null, false],
  ] as const)("classifies %s without model-owned launch claims", async (file, kind, launcher, directExec) => {
    const target = await executable(`kind-${kind}`, file)
    const entry = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        return (yield* catalog.upsert({ name: `kind-${kind}`, path: target, source: "resolved" })).entry
      }),
    )

    expect(entry).toMatchObject({ kind, launcher, directExec })
  })

  test("resolves only active native entries by exact catalog id", async () => {
    const git = await executable("resolve-native", "git.exe")
    const npm = await executable("resolve-script", "npm.cmd")
    const result = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        const native = yield* catalog.upsert({ name: "git", path: git, source: "resolved" })
        const script = yield* catalog.upsert({ name: "npm", path: npm, source: "resolved" })
        const resolved = yield* catalog.resolveExecutable(native.entry.id)
        return {
          resolved,
          script: yield* Effect.exit(catalog.resolveExecutable(script.entry.id)),
          missing: yield* Effect.exit(catalog.resolveExecutable(`${native.entry.id}-missing`)),
        }
      }),
    )

    expect(result.resolved).toMatchObject({ name: "git", path: path.resolve(git), directExec: true })
    expect(result.script._tag).toBe("Failure")
    expect(result.missing._tag).toBe("Failure")
  })

  test("rejects stale, changed, and missing native entries without rewriting the catalog", async () => {
    const stalePath = await executable("resolve-stale", "stale.exe")
    const changedPath = await executable("resolve-changed", "changed.exe", "before")
    const missingPath = await executable("resolve-missing", "missing.exe")
    const result = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        const stale = yield* catalog.upsert({ name: "stale", path: stalePath, source: "resolved" })
        const changed = yield* catalog.upsert({ name: "changed", path: changedPath, source: "resolved" })
        const missing = yield* catalog.upsert({ name: "missing", path: missingPath, source: "resolved" })
        yield* catalog.invalidate({ id: stale.entry.id, reason: "user_requested" })
        yield* Effect.promise(() => writeFile(changedPath, "after-is-different"))
        yield* Effect.promise(() => rm(missingPath, { force: true }))
        const before = yield* Effect.promise(() => readFile(catalog.file, "utf8"))
        const exits = {
          stale: yield* Effect.exit(catalog.resolveExecutable(stale.entry.id)),
          changed: yield* Effect.exit(catalog.resolveExecutable(changed.entry.id)),
          missing: yield* Effect.exit(catalog.resolveExecutable(missing.entry.id)),
        }
        const after = yield* Effect.promise(() => readFile(catalog.file, "utf8"))
        return { exits, before, after }
      }),
    )

    expect(result.exits.stale._tag).toBe("Failure")
    expect(result.exits.changed._tag).toBe("Failure")
    expect(result.exits.missing._tag).toBe("Failure")
    expect(result.after).toBe(result.before)
  })

  test("lists all cataloged names in order without probing or returning entry details", async () => {
    const zeta = await executable("list-zeta", "zeta.exe")
    const alpha = await executable("list-alpha", "alpha.exe")
    await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        const zetaEntry = yield* catalog.upsert({ name: "zeta", path: zeta, source: "resolved" })
        const alphaEntry = yield* catalog.upsert({ name: "alpha", path: alpha, source: "resolved" })
        yield* catalog.invalidate({ id: alphaEntry.entry.id, reason: "user_requested" })
        return zetaEntry
      }),
    )
    const result = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make({
          probe: () => Effect.fail(new EnvironmentToolsCatalog.CatalogError({ message: "probe must not run" })),
        })
        return yield* catalog.listNames()
      }),
    )

    expect(result).toEqual({ operation: "search", mode: "all", count: 2, names: ["alpha", "zeta"] })
    expect(JSON.stringify(result)).not.toContain("path")
    expect(JSON.stringify(result)).not.toContain("status")
    expect(JSON.stringify(result)).not.toContain("directExec")
  })

  test("rejects relative and missing paths without creating a catalog", async () => {
    const results = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        const relative = yield* Effect.exit(catalog.upsert({ name: "git", path: "git.exe", source: "resolved" }))
        const missing = yield* Effect.exit(
          catalog.upsert({ name: "git", path: path.join(root, "missing", "git.exe"), source: "resolved" }),
        )
        return { relative, missing, file: catalog.file }
      }),
    )

    expect(results.relative._tag).toBe("Failure")
    expect(results.missing._tag).toBe("Failure")
    expect(await Bun.file(results.file).exists()).toBe(false)
  })

  test("rejects oversized metadata before persistent mutation", async () => {
    const git = await executable("bin", "git.exe")
    const result = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        const exit = yield* Effect.exit(
          catalog.upsert({
            name: "git",
            path: git,
            aliases: Array.from({ length: 21 }, (_, index) => `git-${index}`),
            source: "resolved",
          }),
        )
        return { exit, file: catalog.file }
      }),
    )

    expect(result.exit._tag).toBe("Failure")
    expect(await Bun.file(result.file).exists()).toBe(false)
  })

  test("distinguishes changed, non-file, missing, and inspection errors without catalog mutation", async () => {
    const git = await executable("bin", "git.exe", "before")
    const result = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        yield* catalog.upsert({ name: "git", path: git, source: "resolved" })
        yield* Effect.promise(() => writeFile(git, "after-change"))
        const changed = yield* catalog.search("git")
        yield* Effect.promise(() => rm(git, { force: true }))
        yield* Effect.promise(() => mkdir(git))
        const directory = yield* catalog.search("git")
        yield* Effect.promise(() => rm(git, { recursive: true, force: true }))
        const missing = yield* catalog.search("git")
        const before = yield* Effect.promise(() => readFile(catalog.file, "utf8"))
        const deniedCatalog = yield* EnvironmentToolsCatalog.make({
          probe: () => Effect.fail(new EnvironmentToolsCatalog.CatalogError({ message: "Access denied" })),
        })
        const denied = yield* Effect.exit(deniedCatalog.search("git"))
        const after = yield* Effect.promise(() => readFile(catalog.file, "utf8"))
        return { changed, directory, missing, denied, before, after, document: yield* catalog.read() }
      }),
    )

    expect(result.changed.matches[0]).toMatchObject({ exists: true, status: "stale" })
    expect(result.directory.matches[0]).toMatchObject({ exists: true, status: "stale" })
    expect(result.missing.matches[0]).toMatchObject({ exists: false, status: "stale" })
    expect(result.denied._tag).toBe("Failure")
    expect(result.after).toBe(result.before)
    expect(result.document.tools.git.status).toBe("active")
  })

  test("fails closed on malformed catalog content", async () => {
    const config = path.join(root, "config")
    await mkdir(config, { recursive: true })
    const file = path.join(config, EnvironmentToolsCatalog.filename)
    const git = await executable("bin", "git.exe")
    await writeFile(file, "{not-json")

    const exits = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        return {
          search: yield* Effect.exit(catalog.search("git")),
          update: yield* Effect.exit(catalog.upsert({ name: "git", path: git, source: "resolved" })),
        }
      }),
    )

    expect(exits.search._tag).toBe("Failure")
    expect(exits.update._tag).toBe("Failure")
    expect(await readFile(file, "utf8")).toBe("{not-json")
  })

  test("fails closed on semantically forged tool-owned fields", async () => {
    const npm = await executable("bin", "npm.cmd")
    const config = path.join(root, "config")
    const file = path.join(config, EnvironmentToolsCatalog.filename)
    const base = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        yield* catalog.upsert({ name: "npm", path: npm, source: "resolved" })
        return yield* Effect.promise(() => readFile(catalog.file, "utf8"))
      }),
    )

    const decodeDocument = Schema.decodeUnknownSync(EnvironmentToolsCatalog.Document)
    const mutations: Array<(document: EnvironmentToolsCatalog.Document) => EnvironmentToolsCatalog.Document> = [
      (document) => ({
        ...document,
        tools: {
          ...document.tools,
          npm: { ...document.tools.npm, kind: "native", launcher: null, directExec: true },
        },
      }),
      (document) => ({
        ...document,
        tools: { ...document.tools, npm: { ...document.tools.npm, id: "forged-id" } },
      }),
      (document) => ({
        ...document,
        tools: { ...document.tools, npm: { ...document.tools.npm, discoveredAt: "not-a-time" } },
      }),
    ]

    for (const mutate of mutations) {
      const document = mutate(decodeDocument(JSON.parse(base)))
      const bytes = JSON.stringify(document, undefined, 2) + "\n"
      await writeFile(file, bytes)
      const exits = await run(
        Effect.gen(function* () {
          const catalog = yield* EnvironmentToolsCatalog.make()
          return {
            search: yield* Effect.exit(catalog.search("npm")),
            update: yield* Effect.exit(catalog.upsert({ name: "npm", path: npm, source: "resolved" })),
          }
        }),
      )
      expect(exits.search._tag).toBe("Failure")
      expect(exits.update._tag).toBe("Failure")
      expect(await readFile(file, "utf8")).toBe(bytes)
    }
  })

  test("fails closed on persisted wildcard-bearing program names", async () => {
    const npm = await executable("wildcard-forgery", "npm.cmd")
    const config = path.join(root, "config")
    const file = path.join(config, EnvironmentToolsCatalog.filename)
    const base = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        yield* catalog.upsert({ name: "npm", path: npm, source: "resolved" })
        return yield* Effect.promise(() => readFile(catalog.file, "utf8"))
      }),
    )
    const decodeDocument = Schema.decodeUnknownSync(EnvironmentToolsCatalog.Document)

    for (const name of ["*", "?"]) {
      const document = decodeDocument(JSON.parse(base))
      const entry = { ...document.tools.npm, id: `${document.environment.id}:${name}`, name }
      const bytes = JSON.stringify({ ...document, tools: { ...document.tools, [name]: entry } }, undefined, 2) + "\n"
      await writeFile(file, bytes)
      const exit = await run(
        Effect.gen(function* () {
          const catalog = yield* EnvironmentToolsCatalog.make()
          return yield* Effect.exit(catalog.search("npm"))
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(await readFile(file, "utf8")).toBe(bytes)
    }
  })

  test("rejects catalogs from another environment ID or operating system", async () => {
    const environmentA = "11111111-1111-4111-8111-111111111111"
    const environmentB = "22222222-2222-4222-8222-222222222222"
    const git = await executable("bin", "git.exe")
    const file = path.join(root, "config", EnvironmentToolsCatalog.filename)

    await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make({ environmentID: environmentA })
        yield* catalog.upsert({ name: "git", path: git, source: "resolved" })
      }),
    )
    const original = await readFile(file, "utf8")
    const foreign = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make({ environmentID: environmentB })
        return {
          search: yield* Effect.exit(catalog.search("git")),
          update: yield* Effect.exit(catalog.upsert({ name: "git", path: git, source: "resolved" })),
        }
      }),
    )
    expect(foreign.search._tag).toBe("Failure")
    expect(foreign.update._tag).toBe("Failure")
    expect(await readFile(file, "utf8")).toBe(original)

    const wrongOS = JSON.parse(original)
    wrongOS.environment.os = process.platform === "win32" ? "linux" : "win32"
    const wrongOSBytes = JSON.stringify(wrongOS, undefined, 2) + "\n"
    await writeFile(file, wrongOSBytes)
    const osExit = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make({ environmentID: environmentA })
        return yield* Effect.exit(catalog.search("git"))
      }),
    )
    expect(osExit._tag).toBe("Failure")
    expect(await readFile(file, "utf8")).toBe(wrongOSBytes)
  })

  test("serializes concurrent updates without losing different names", async () => {
    const git = await executable("bin", "git.exe")
    const bun = await executable("bin", "bun.exe")
    const tools = await run(
      Effect.gen(function* () {
        const first = yield* EnvironmentToolsCatalog.make()
        const second = yield* EnvironmentToolsCatalog.make()
        yield* Effect.all(
          [
            first.upsert({ name: "git", path: git, source: "resolved" }),
            second.upsert({ name: "bun", path: bun, source: "resolved" }),
          ],
          { concurrency: "unbounded" },
        )
        return (yield* first.read()).tools
      }),
    )

    expect(Object.keys(tools).sort()).toEqual(["bun", "git"])
  })

  test("serializes concurrent updates of one normalized name into one entry", async () => {
    const firstPath = await executable("first", "git.exe", "first")
    const secondPath = await executable("second", "git.exe", "second")
    const tools = await run(
      Effect.gen(function* () {
        const first = yield* EnvironmentToolsCatalog.make()
        const second = yield* EnvironmentToolsCatalog.make()
        yield* Effect.all(
          [
            first.upsert({ name: "git", path: firstPath, source: "resolved" }),
            second.upsert({ name: "git.exe", path: secondPath, source: "successful_execution" }),
          ],
          { concurrency: "unbounded" },
        )
        return (yield* first.read()).tools
      }),
    )

    expect(Object.keys(tools)).toEqual(["git"])
    expect([path.resolve(firstPath), path.resolve(secondPath)]).toContain(tools.git.path)
  })

  test("invalidates the existing named entry without creating history duplicates", async () => {
    const git = await executable("bin", "git.exe")
    const tools = await run(
      Effect.gen(function* () {
        const catalog = yield* EnvironmentToolsCatalog.make()
        const created = yield* catalog.upsert({ name: "git", path: git, source: "resolved" })
        yield* catalog.invalidate({ id: created.entry.id, reason: "user_requested" })
        return (yield* catalog.read()).tools
      }),
    )

    expect(Object.keys(tools)).toEqual(["git"])
    expect(tools.git).toMatchObject({ status: "stale", staleReason: "user_requested" })
  })
})
