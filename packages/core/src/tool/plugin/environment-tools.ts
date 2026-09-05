export * as EnvironmentToolsTool from "./environment-tools.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { EnvironmentToolsCatalog } from "../../environment-tools/catalog.js"
import { Permission } from "../../permission.js"

export const Input = Schema.Struct({
  search: Schema.optional(
    Schema.Union([
      Schema.Struct({
        query: Schema.String.annotate({ description: "Program name, alias, path basename, or capability" }),
        limit: Schema.optional(Schema.Number.annotate({ description: "Maximum matches (1-20, default 5)" })),
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
      Schema.Struct({
        all: Schema.Literal(true).annotate({ description: "List every cataloged program name without details" }),
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
    ]),
  ),
  update: Schema.optional(
    Schema.Union([
      Schema.Struct({
        mode: Schema.Literal("upsert"),
        name: Schema.String,
        path: Schema.String,
        aliases: Schema.optional(Schema.Array(Schema.String)),
        capabilities: Schema.optional(Schema.Array(Schema.String)),
        source: Schema.Literals(["resolved", "successful_execution", "user_provided"]),
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
      Schema.Struct({
        mode: Schema.Literal("invalidate"),
        id: Schema.String,
        reason: Schema.Literals(["path_missing", "replaced", "user_requested", "other"]),
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
    ]),
  ),
})

const MatchOutput = Schema.Struct({
  ...EnvironmentToolsCatalog.Entry.fields,
  exists: Schema.Boolean,
  status: Schema.Literals(["active", "stale"]),
})

const Output = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("search"),
    query: Schema.String,
    matches: Schema.Array(MatchOutput),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    operation: Schema.Literal("search"),
    mode: Schema.Literal("all"),
    count: Schema.Number,
    names: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    operation: Schema.Literal("update"),
    result: Schema.Literals(["created", "refreshed", "invalidated"]),
    entry: EnvironmentToolsCatalog.Entry,
  }),
])

const description = [
  "Search or update the persistent catalog of external programs verified in the current local environment.",
  "When no concrete program name is known, use search.all at most once to list cataloged names without details; otherwise use search.query for revalidated details about one program.",
  "The catalog is memory, not an installed-software inventory: a missing name does not mean the program is not installed.",
  "On a miss, continue with normal discovery and update only after a path was successfully resolved, successfully executed, or explicitly provided by the user.",
  "When a query returns an active direct-exec-eligible entry and direct_exec is available, invoke it by catalog id for foreground native argv execution; use shell for shell syntax, scripts, stdin, custom environment, or background jobs.",
  "This tool records environment facts; it does not execute programs or grant execution permission.",
].join(" ")

export const Plugin = {
  id: "opencode.tool.environment-tools",
  effect: Effect.fn("EnvironmentToolsTool.Plugin")(function* (ctx: PluginContext) {
    const catalog = yield* EnvironmentToolsCatalog.make()
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name: "environment_tools",
          description,
          input: Input,
          output: Output,
          options: { codemode: false },
          execute: (input, tool) =>
            Effect.gen(function* () {
              const source = { type: "tool" as const, messageID: tool.messageID, id: tool.id }
              if (Number(input.search !== undefined) + Number(input.update !== undefined) !== 1) {
                return yield* new ToolFailure({ message: "Provide exactly one of search or update" })
              }

              if (input.search !== undefined) {
                const listAll = "all" in input.search
                yield* permission.assert({
                  action: "environment_tools",
                  resources: [listAll ? "search:all" : `search:${input.search.query}`],
                  save: ["*"],
                  metadata: listAll ? { all: true } : { query: input.search.query },
                  sessionID: tool.sessionID,
                  agent: tool.agent,
                  source,
                })
                if (listAll) {
                  const result = yield* catalog
                    .listNames()
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
                  return {
                    output: result,
                    content: [
                      {
                        type: "text" as const,
                        text:
                          result.count === 0
                            ? "No environment tools are cataloged."
                            : JSON.stringify(result, undefined, 2),
                      },
                    ],
                    metadata: { title: `Environment tools catalog: ${result.count} names` },
                  }
                }
                const result = yield* catalog
                  .search(input.search.query, input.search.limit)
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
                return {
                  output: result,
                  content: [
                    {
                      type: "text" as const,
                      text:
                        result.matches.length === 0
                          ? `No environment tools matched ${JSON.stringify(result.query)}.`
                          : JSON.stringify(result, undefined, 2),
                    },
                  ],
                  metadata: { title: `Environment tools: ${result.query}` },
                }
              }

              const update = input.update!
              if (update.mode === "upsert") {
                if (update.name === undefined || update.path === undefined || update.source === undefined) {
                  return yield* new ToolFailure({ message: "Upsert requires name, path, and source" })
                }
                yield* permission.assert({
                  action: "environment_tools_update",
                  resources: [`upsert:${update.name}:${update.path}`],
                  save: ["*"],
                  metadata: { mode: update.mode, name: update.name, path: update.path },
                  sessionID: tool.sessionID,
                  agent: tool.agent,
                  source,
                })
                const result = yield* catalog
                  .upsert({
                    name: update.name,
                    path: update.path,
                    aliases: update.aliases,
                    capabilities: update.capabilities,
                    source: update.source,
                  })
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
                return {
                  output: result,
                  content: [{ type: "text" as const, text: JSON.stringify(result, undefined, 2) }],
                  metadata: { title: `Environment tool updated: ${result.entry.name}` },
                }
              }

              if (update.id === undefined || update.reason === undefined) {
                return yield* new ToolFailure({ message: "Invalidate requires id and reason" })
              }
              yield* permission.assert({
                action: "environment_tools_update",
                resources: [`invalidate:${update.id}`],
                save: ["*"],
                metadata: { mode: update.mode, id: update.id },
                sessionID: tool.sessionID,
                agent: tool.agent,
                source,
              })
              const result = yield* catalog
                .invalidate({ id: update.id, reason: update.reason })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
              return {
                output: result,
                content: [{ type: "text" as const, text: JSON.stringify(result, undefined, 2) }],
                metadata: { title: `Environment tool invalidated: ${result.entry.name}` },
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: "Unable to use the environment tools catalog", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
