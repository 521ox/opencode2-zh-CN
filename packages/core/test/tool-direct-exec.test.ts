import { describe, expect } from "bun:test"
import { link, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Duration, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Environment } from "@opencode-ai/core/environment/index"
import { EnvironmentToolsCatalog } from "@opencode-ai/core/environment-tools/catalog"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Location } from "@opencode-ai/core/location"
import { Permission } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool"
import { DirectExecTool } from "@opencode-ai/core/tool/plugin/direct-exec"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"
import { AppProcess } from "@opencode-ai/util/process"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_direct_exec")
const itWindows = process.platform === "win32" ? it.live : it.live.skip

const call = (id: string, input: unknown) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "direct_exec", input },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const rootFields = (schema: unknown) => {
  if (!isRecord(schema) || !isRecord(schema.properties)) return []
  return Object.keys(schema.properties).sort()
}

const directExecNode = makeLocationNode({
  name: "test/direct-exec-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(DirectExecTool.Plugin)),
  deps: [
    Tool.node,
    FSUtil.node,
    Global.node,
    Environment.node,
    Location.node,
    LocationMutation.node,
    Permission.node,
    AppProcess.node,
  ],
})

const makeLayer = (
  tmp: Awaited<ReturnType<typeof tmpdir>>,
  project: string,
  permission: Layer.Layer<Permission.Service>,
) => {
  return AppNodeBuilder.build(LayerNode.group([Tool.node, FSUtil.node, Global.node, directExecNode]), [
    [
      Global.node,
      Global.layerWith({
        config: path.join(tmp.path, "config"),
        state: path.join(tmp.path, "state"),
        data: path.join(tmp.path, "data"),
        cache: path.join(tmp.path, "cache"),
        tmp: path.join(tmp.path, "tmp"),
      }),
    ],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
    ],
    [Permission.node, permission],
  ])
}

describe("DirectExecTool", () => {
  itWindows("registers a strict argv-only schema and executes special characters without a shell", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const script = path.join(project, "argv.js")
          const replacement = path.join(project, "bun-updated.exe")
          yield* Effect.promise(() => mkdir(project, { recursive: true }))
          yield* Effect.promise(() => writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))"))
          yield* Effect.promise(() => link(process.execPath, replacement))
          const assertions: Permission.AssertInput[] = []
          const layer = makeLayer(
            tmp,
            project,
            permissionLayer({ assert: (input) => Effect.sync(() => assertions.push(input)) }),
          )

          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            const catalog = yield* EnvironmentToolsCatalog.make()
            const entry = yield* catalog.upsert({ name: "bun", path: process.execPath, source: "resolved" })
            const definitions = yield* toolDefinitions(registry)
            const definition =
              definitions.find((candidate) => candidate.name === "direct_exec") ??
              (yield* Effect.die("direct_exec definition missing"))
            expect(rootFields(definition.inputSchema)).toEqual(["args", "cwd", "id", "timeoutMs"])
            expect(JSON.stringify(definition.inputSchema)).not.toContain('"command"')
            expect(JSON.stringify(definition.inputSchema)).not.toContain('"path"')
            expect(JSON.stringify(definition.inputSchema)).not.toContain('"env"')
            expect(JSON.stringify(definition.inputSchema)).not.toContain('"stdin"')
            expect(JSON.stringify(definition.inputSchema)).not.toContain('"background"')
            expect(definition.description).toContain("environment_tools search.query")
            expect(definition.description).toContain("never guess an id")
            expect(definition.description).toContain("separate args item")
            expect(definition.description).toContain("Never place a shell command line")
            expect(definition.description).toContain("Use shell")

            const first = yield* executeTool(
              registry,
              call("call-argv-1", {
                id: entry.entry.id,
                args: [script, "a&b", "x y", "*.txt"],
              }),
            )
            const updated = yield* catalog.upsert({ name: "bun", path: replacement, source: "resolved" })
            expect(updated.entry.id).toBe(entry.entry.id)
            const second = yield* executeTool(
              registry,
              call("call-argv-2", {
                id: updated.entry.id,
                args: [script, "second"],
              }),
            )
            const firstOutput = Schema.decodeUnknownSync(DirectExecTool.Output)(first.output)
            const secondOutput = Schema.decodeUnknownSync(DirectExecTool.Output)(second.output)
            expect(JSON.parse(firstOutput.stdout)).toEqual(["a&b", "x y", "*.txt"])
            expect(JSON.parse(secondOutput.stdout)).toEqual(["second"])
            expect(firstOutput.exitCode).toBe(0)
            expect(firstOutput.cwd).toBe(path.resolve(project))

            const direct = assertions.filter((input) => input.action === "direct_exec")
            expect(direct).toHaveLength(2)
            expect(direct[0]).toMatchObject({
              resources: [entry.entry.id],
              save: [entry.entry.id],
              metadata: { scope: "program_all_arguments_across_updates" },
            })
            expect(direct[1]?.resources).toEqual(direct[0]?.resources)
            expect(assertions.some((input) => input.action === "external_directory")).toBe(false)
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  itWindows("returns non-zero exits and independently truncates stdout and stderr", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const script = path.join(project, "output.js")
          yield* Effect.promise(() => mkdir(project, { recursive: true }))
          yield* Effect.promise(() =>
            writeFile(
              script,
              'process.stdout.write("x".repeat(70000)); process.stderr.write("y".repeat(70000)); process.exit(7)',
            ),
          )
          const layer = makeLayer(tmp, project, permissionLayer({ assert: () => Effect.void }))
          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            const catalog = yield* EnvironmentToolsCatalog.make()
            const entry = yield* catalog.upsert({ name: "bun", path: process.execPath, source: "resolved" })
            const result = yield* executeTool(registry, call("call-output", { id: entry.entry.id, args: [script] }))
            const output = Schema.decodeUnknownSync(DirectExecTool.Output)(result.output)
            expect(output.exitCode).toBe(7)
            expect(output.stdoutTruncated).toBe(true)
            expect(output.stderrTruncated).toBe(true)
            expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(DirectExecTool.constants.MAX_OUTPUT_BYTES)
            expect(Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(DirectExecTool.constants.MAX_OUTPUT_BYTES)
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  itWindows("rejects unsupported entries and unknown public fields before permission", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const script = path.join(project, "npm.cmd")
          yield* Effect.promise(() => mkdir(project, { recursive: true }))
          yield* Effect.promise(() => writeFile(script, "@echo off"))
          const assertions: Permission.AssertInput[] = []
          const layer = makeLayer(
            tmp,
            project,
            permissionLayer({ assert: (input) => Effect.sync(() => assertions.push(input)) }),
          )
          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            const catalog = yield* EnvironmentToolsCatalog.make()
            const entry = yield* catalog.upsert({ name: "npm", path: script, source: "resolved" })
            const unsupported = yield* executeTool(
              registry,
              call("call-script", { id: entry.entry.id, args: ["--version"] }),
            )
            const unknown = yield* executeTool(
              registry,
              call("call-unknown", { id: entry.entry.id, args: [], command: "npm --version" }),
            )
            const timeout = yield* executeTool(
              registry,
              call("call-timeout-invalid", { id: entry.entry.id, timeoutMs: 99 }),
            )
            const argumentsOverflow = yield* executeTool(
              registry,
              call("call-args-overflow", { id: entry.entry.id, args: Array.from({ length: 129 }, () => "x") }),
            )
            const cwd = yield* executeTool(registry, call("call-cwd-empty", { id: entry.entry.id, cwd: "" }))
            expect(unsupported.status).toBe("error")
            expect(unknown.status).toBe("error")
            expect(timeout.status).toBe("error")
            expect(argumentsOverflow.status).toBe("error")
            expect(cwd.status).toBe("error")
            expect(assertions).toEqual([])
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  itWindows("stops when the executable changes while permission is pending", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const executable = path.join(project, "runner.exe")
          yield* Effect.promise(() => mkdir(project, { recursive: true }))
          yield* Effect.promise(() => writeFile(executable, "before"))
          const assertions: Permission.AssertInput[] = []
          const layer = makeLayer(
            tmp,
            project,
            permissionLayer({
              assert: (input) =>
                Effect.gen(function* () {
                  assertions.push(input)
                  if (input.action === "direct_exec") {
                    yield* Effect.promise(() => writeFile(executable, "changed-after-permission"))
                  }
                }),
            }),
          )
          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            const catalog = yield* EnvironmentToolsCatalog.make()
            const entry = yield* catalog.upsert({ name: "runner", path: executable, source: "resolved" })
            const result = yield* executeTool(registry, call("call-race", { id: entry.entry.id, args: [] }))
            expect(result).toMatchObject({
              status: "error",
              error: { message: expect.stringContaining("changed after it was cataloged") },
            })
            expect(assertions.filter((input) => input.action === "direct_exec")).toHaveLength(1)
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  itWindows("requests external-directory permission independently", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const external = path.join(tmp.path, "external")
          yield* Effect.promise(() => mkdir(project, { recursive: true }))
          yield* Effect.promise(() => mkdir(external, { recursive: true }))
          const assertions: Permission.AssertInput[] = []
          const layer = makeLayer(
            tmp,
            project,
            permissionLayer({ assert: (input) => Effect.sync(() => assertions.push(input)) }),
          )
          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            const catalog = yield* EnvironmentToolsCatalog.make()
            const entry = yield* catalog.upsert({ name: "bun", path: process.execPath, source: "resolved" })
            yield* executeTool(
              registry,
              call("call-external", { id: entry.entry.id, args: ["--version"], cwd: external }),
            )
            expect(assertions.map((input) => input.action)).toEqual(["external_directory", "direct_exec"])
            expect(assertions[1]).toMatchObject({ resources: [entry.entry.id], save: [entry.entry.id] })
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  itWindows("rejects invalid external working directories before requesting permission", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const missing = path.join(tmp.path, "outside", "missing")
          const file = path.join(tmp.path, "outside", "file.txt")
          yield* Effect.promise(() => mkdir(project, { recursive: true }))
          yield* Effect.promise(() => mkdir(path.dirname(file), { recursive: true }))
          yield* Effect.promise(() => writeFile(file, "not a directory"))
          const assertions: Permission.AssertInput[] = []
          const layer = makeLayer(
            tmp,
            project,
            permissionLayer({ assert: (input) => Effect.sync(() => assertions.push(input)) }),
          )
          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            const catalog = yield* EnvironmentToolsCatalog.make()
            const entry = yield* catalog.upsert({ name: "bun", path: process.execPath, source: "resolved" })
            const missingResult = yield* executeTool(
              registry,
              call("call-external-missing", { id: entry.entry.id, args: ["--version"], cwd: missing }),
            )
            const fileResult = yield* executeTool(
              registry,
              call("call-external-file", { id: entry.entry.id, args: ["--version"], cwd: file }),
            )
            expect(missingResult).toMatchObject({
              status: "error",
              error: { message: expect.stringContaining("Working directory does not exist") },
            })
            expect(fileResult).toMatchObject({
              status: "error",
              error: { message: expect.stringContaining("Working directory is not a directory") },
            })
            expect(assertions).toEqual([])
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  itWindows(
    "times out and leaves no child process running",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const script = path.join(project, "wait.js")
            const pidFile = path.join(project, "child.pid")
            yield* Effect.promise(() => mkdir(project, { recursive: true }))
            yield* Effect.promise(() =>
              writeFile(script, "await Bun.write(process.argv[2], String(process.pid)); await new Promise(() => {})"),
            )
            const layer = makeLayer(tmp, project, permissionLayer({ assert: () => Effect.void }))
            return yield* Effect.gen(function* () {
              const registry = yield* Tool.Service
              const catalog = yield* EnvironmentToolsCatalog.make()
              const entry = yield* catalog.upsert({ name: "bun", path: process.execPath, source: "resolved" })
              const result = yield* executeTool(
                registry,
                call("call-timeout", {
                  id: entry.entry.id,
                  args: [script, pidFile],
                  timeoutMs: 500,
                }),
              )
              expect(result).toMatchObject({
                status: "error",
                error: { message: "Direct execution timed out after 500 ms" },
              })
              const pid = Number(yield* Effect.promise(() => readFile(pidFile, "utf8")))
              yield* Effect.sleep(Duration.millis(100))
              const alive = yield* Effect.sync(() => {
                try {
                  process.kill(pid, 0)
                  return true
                } catch {
                  return false
                }
              })
              expect(alive).toBe(false)
            }).pipe(Effect.provide(layer))
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    5_000,
  )
})
