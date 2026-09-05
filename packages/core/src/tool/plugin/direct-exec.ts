export * as DirectExecTool from "./direct-exec.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { Duration, Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/util/process"
import { Environment } from "../../environment/index.js"
import { EnvironmentToolsCatalog } from "../../environment-tools/catalog.js"
import { Location } from "../../location.js"
import { LocationMutation } from "../../location-mutation.js"
import { Permission } from "../../permission.js"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_ARGS = 128
const MAX_ARG_LENGTH = 4_096
const MAX_ARGS_LENGTH = 32_768
const MAX_OUTPUT_BYTES = 65_536

export const Input = Schema.Struct({
  id: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

export const Output = Schema.Struct({
  status: Schema.Literal("exited"),
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  cwd: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  durationMs: Schema.Number,
})

const description = [
  "Execute an active native EXE or COM entry from the environment tools catalog without a host shell.",
  "Obtain the catalog id from environment_tools search.query and never guess an id or substitute a raw path; catalog membership is not execution permission.",
  "Pass each argument as a separate args item. Never place a shell command line, pipeline, redirect, environment assignment, or quoting wrapper into one argument.",
  "Use shell when the operation requires shell syntax, a script launcher, stdin, an interactive terminal, custom environment variables, or background execution.",
].join(" ")

const validateInput = (input: typeof Input.Type) => {
  const id = input.id.trim()
  const args = [...(input.args ?? [])]
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!id || id.length > 256) return new ToolFailure({ message: "Catalog entry id must be 1 to 256 characters" })
  if (args.length > MAX_ARGS)
    return new ToolFailure({ message: `Direct execution accepts at most ${MAX_ARGS} arguments` })
  if (args.some((arg) => arg.length > MAX_ARG_LENGTH || arg.includes("\0"))) {
    return new ToolFailure({ message: `Each argument must be at most ${MAX_ARG_LENGTH} characters and contain no NUL` })
  }
  if (args.reduce((total, arg) => total + arg.length, 0) > MAX_ARGS_LENGTH) {
    return new ToolFailure({ message: `Direct execution arguments are limited to ${MAX_ARGS_LENGTH} characters` })
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    return new ToolFailure({ message: `timeoutMs must be an integer from 100 to ${MAX_TIMEOUT_MS}` })
  }
  if (input.cwd !== undefined && (!input.cwd.trim() || input.cwd.length > 4_096 || input.cwd.includes("\0"))) {
    return new ToolFailure({ message: "cwd must be 1 to 4096 characters and contain no NUL" })
  }
  return { id, args, timeoutMs }
}

const sameExecutable = (left: EnvironmentToolsCatalog.Entry, right: EnvironmentToolsCatalog.Entry): boolean =>
  left.id === right.id &&
  left.path === right.path &&
  left.identity.size === right.identity.size &&
  left.identity.modifiedAt === right.identity.modifiedAt

export const Plugin = {
  id: "opencode.tool.direct-exec",
  effect: Effect.fn("DirectExecTool.Plugin")(function* (ctx: PluginContext) {
    const catalog = yield* EnvironmentToolsCatalog.make()
    const environment = yield* Environment.Service
    const location = yield* Location.Service
    const locationMutation = yield* LocationMutation.Service
    const permission = yield* Permission.Service
    const process = yield* AppProcess.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name: "direct_exec",
          description,
          input: Input,
          output: Output,
          options: { codemode: false },
          execute: (input, tool) =>
            Effect.gen(function* () {
              const valid = validateInput(input)
              if (valid instanceof ToolFailure) return yield* valid
              const source = { type: "tool" as const, messageID: tool.messageID, id: tool.id }
              const initial = yield* catalog
                .resolveExecutable(valid.id)
                .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
              const target = yield* locationMutation.resolve({
                path: input.cwd ?? location.directory,
                kind: "directory",
              })
              const workdir = yield* Environment.typeFollowing(environment.files, target.absolute).pipe(
                Effect.catchTag("Environment.NotFound", () =>
                  Effect.fail(new ToolFailure({ message: `Working directory does not exist: ${target.absolute}` })),
                ),
              )
              if (workdir !== "directory") {
                return yield* new ToolFailure({ message: `Working directory is not a directory: ${target.absolute}` })
              }
              if (target.externalDirectory) {
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                  metadata: { path: target.absolute },
                  sessionID: tool.sessionID,
                  agent: tool.agent,
                  source,
                })
              }

              yield* permission.assert({
                action: "direct_exec",
                resources: [initial.id],
                save: [initial.id],
                metadata: {
                  name: initial.name,
                  path: initial.path,
                  args: valid.args,
                  cwd: target.absolute,
                  scope: "program_all_arguments_across_updates",
                },
                sessionID: tool.sessionID,
                agent: tool.agent,
                source,
              })

              const executable = yield* catalog
                .resolveExecutable(valid.id)
                .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
              if (!sameExecutable(initial, executable)) {
                return yield* new ToolFailure({
                  message: `Environment tool changed while execution permission was pending: ${initial.name}`,
                })
              }

              yield* tool.progress({ title: `Running ${executable.name}` })
              const startedAt = Date.now()
              const result = yield* process.run(
                ChildProcess.make(executable.path, valid.args, {
                  cwd: target.absolute,
                  shell: false,
                  extendEnv: true,
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                  forceKillAfter: Duration.seconds(2),
                }),
                {
                  timeout: Duration.millis(valid.timeoutMs),
                  maxOutputBytes: MAX_OUTPUT_BYTES,
                  maxErrorBytes: MAX_OUTPUT_BYTES,
                },
              )
              const output: typeof Output.Type = {
                status: "exited",
                id: executable.id,
                name: executable.name,
                path: executable.path,
                cwd: target.absolute,
                exitCode: result.exitCode,
                stdout: result.stdout.toString("utf8"),
                stderr: result.stderr.toString("utf8"),
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
                durationMs: Date.now() - startedAt,
              }
              return {
                output,
                content: [{ type: "text" as const, text: JSON.stringify(output, undefined, 2) }],
                metadata: {
                  title: `${executable.name} exited with code ${result.exitCode}`,
                  exitCode: result.exitCode,
                  stdoutTruncated: result.stdoutTruncated,
                  stderrTruncated: result.stderrTruncated,
                },
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : error instanceof AppProcess.AppProcessError
                    ? new ToolFailure({
                        message: /timed out/i.test(error.message)
                          ? `Direct execution timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`
                          : "Unable to execute cataloged program directly",
                      })
                    : new ToolFailure({ message: "Unable to execute cataloged program directly", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

export const constants = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_ARGS,
  MAX_ARG_LENGTH,
  MAX_ARGS_LENGTH,
  MAX_OUTPUT_BYTES,
} as const
