import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool"
import { EnvironmentToolsTool } from "@opencode-ai/core/tool/plugin/environment-tools"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"
import { tmpdir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const environmentToolsNode = makeLocationNode({
  name: "test/environment-tools-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(EnvironmentToolsTool.Plugin)),
  deps: [Tool.node, FSUtil.node, Global.node, Location.node, LocationMutation.node, Permission.node],
})

const sessionID = Session.ID.make("ses_environment_tools_test")
const call = (id: string, input: unknown) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "environment_tools", input },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const modeFields = (schema: unknown, mode: string) => {
  const pending = [schema]
  while (pending.length > 0) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    if (!isRecord(current)) continue
    const properties = isRecord(current.properties) ? current.properties : undefined
    const modeSchema = properties && isRecord(properties.mode) ? properties.mode : undefined
    if (properties && modeSchema && Array.isArray(modeSchema.enum) && modeSchema.enum.includes(mode))
      return Object.keys(properties).sort()
    pending.push(...Object.values(current))
  }
  return []
}

describe("EnvironmentToolsTool", () => {
  it.live("registers one definition and separates search from update permission", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const assertions: Permission.AssertInput[] = []
          const permission = permissionLayer({
            assert: (input) => Effect.sync(() => assertions.push(input)),
          })
          const config = path.join(tmp.path, "config")
          const state = path.join(tmp.path, "state")
          const executable = path.join(tmp.path, "bin", "git.exe")
          yield* Effect.promise(() => mkdir(path.dirname(executable), { recursive: true }))
          yield* Effect.promise(() => writeFile(executable, "git"))

          const toolLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, environmentToolsNode]), [
            [Permission.node, permission],
            [Global.node, Global.layerWith({ config, state, data: tmp.path, cache: tmp.path, tmp: tmp.path })],
            [
              Location.node,
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            ],
          ])

          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.filter((definition) => definition.name === "environment_tools")).toHaveLength(1)
            const definition =
              definitions.find((candidate) => candidate.name === "environment_tools") ??
              (yield* Effect.die("environment_tools definition missing"))
            expect(modeFields(definition.inputSchema, "upsert")).toEqual([
              "aliases",
              "capabilities",
              "mode",
              "name",
              "path",
              "source",
            ])
            expect(modeFields(definition.inputSchema, "invalidate")).toEqual(["id", "mode", "reason"])
            expect(definition.description).toContain("search.all")
            expect(definition.description).toContain("search.query")
            expect(definition.description).toContain("missing name does not mean the program is not installed")
            expect(definition.description).toContain("normal discovery")
            expect(definition.description).toContain("direct_exec")
            expect(definition.description).toContain("use shell")

            const empty = yield* executeTool(registry, call("call-search-empty", { search: { query: "git" } }))
            expect(empty).toMatchObject({
              status: "completed",
              output: { operation: "search", matches: [], truncated: false },
            })
            const emptyAll = yield* executeTool(registry, call("call-list-empty", { search: { all: true } }))
            expect(emptyAll).toMatchObject({
              status: "completed",
              output: { operation: "search", mode: "all", count: 0, names: [] },
            })

            const updated = yield* executeTool(
              registry,
              call("call-update", {
                update: {
                  mode: "upsert",
                  name: "git",
                  path: executable,
                  capabilities: ["version-control"],
                  source: "successful_execution",
                },
              }),
            )
            expect(updated).toMatchObject({
              status: "completed",
              output: {
                operation: "update",
                result: "created",
                entry: { name: "git", kind: "native", directExec: true },
              },
            })

            const all = yield* executeTool(registry, call("call-list-all", { search: { all: true } }))
            expect(all).toEqual({
              status: "completed",
              output: { operation: "search", mode: "all", count: 1, names: ["git"] },
              content: [
                {
                  type: "text",
                  text: '{\n  "operation": "search",\n  "mode": "all",\n  "count": 1,\n  "names": [\n    "git"\n  ]\n}',
                },
              ],
              metadata: { title: "Environment tools catalog: 1 names" },
            })
            expect(JSON.stringify(all.output)).not.toContain("path")
            expect(JSON.stringify(all.output)).not.toContain("status")

            const found = yield* executeTool(registry, call("call-search-found", { search: { query: "git.exe" } }))
            expect(found).toMatchObject({
              status: "completed",
              output: {
                operation: "search",
                matches: [{ name: "git", exists: true, status: "active" }],
              },
            })

            expect(assertions).toMatchObject([
              { action: "environment_tools", save: ["*"] },
              { action: "environment_tools", resources: ["search:all"], save: ["*"] },
              { action: "environment_tools_update", save: ["*"] },
              { action: "environment_tools", resources: ["search:all"], save: ["*"] },
              { action: "environment_tools", save: ["*"] },
            ])
          }).pipe(Effect.provide(toolLayer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects ambiguous operations before persistent mutation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const assertions: Permission.AssertInput[] = []
        const config = path.join(tmp.path, "config")
        const toolLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, environmentToolsNode]), [
          [Permission.node, permissionLayer({ assert: (input) => Effect.sync(() => assertions.push(input)) })],
          [
            Location.node,
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
          ],
          [
            Global.node,
            Global.layerWith({
              config,
              state: path.join(tmp.path, "state"),
              data: tmp.path,
              cache: tmp.path,
              tmp: tmp.path,
            }),
          ],
        ])
        return Effect.gen(function* () {
          const registry = yield* Tool.Service
          const ambiguous = yield* executeTool(
            registry,
            call("call-ambiguous", {
              search: { query: "git" },
              update: { mode: "invalidate", id: "entry-id", reason: "other" },
            }),
          )
          expect(ambiguous).toEqual({
            status: "error",
            error: { type: "tool.execution", message: "Provide exactly one of search or update" },
          })
          const mixedSearch = yield* executeTool(
            registry,
            call("call-mixed-search", { search: { query: "git", all: true } }),
          )
          const mixedUpsert = yield* executeTool(
            registry,
            call("call-mixed-upsert", {
              update: {
                mode: "upsert",
                name: "git",
                path: path.join(tmp.path, "git.exe"),
                source: "resolved",
                id: "forged-id",
                reason: "other",
              },
            }),
          )
          const mixedInvalidate = yield* executeTool(
            registry,
            call("call-mixed-invalidate", {
              update: {
                mode: "invalidate",
                id: "entry-id",
                reason: "other",
                name: "git",
                path: path.join(tmp.path, "git.exe"),
                source: "resolved",
              },
            }),
          )
          expect(mixedUpsert.status).toBe("error")
          expect(mixedInvalidate.status).toBe("error")
          expect(mixedSearch.status).toBe("error")
          expect(assertions).toEqual([])
          expect(yield* Effect.promise(() => Bun.file(path.join(config, "environment-tools.json")).exists())).toBe(
            false,
          )
        }).pipe(Effect.provide(toolLayer))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
