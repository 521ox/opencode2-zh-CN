import { Effect, FileSystem, Option, Scope } from "effect"
import { Command } from "effect/unstable/cli"
import { PrintLogs } from "../commands/commands"
import { GlobalFlags } from "../commands/global-flags"
import { Spec } from "./spec"
import { Global } from "@opencode-ai/util/global"
import { Updater } from "../services/updater"
import { Config } from "../config"
import { Npm } from "@opencode-ai/util/npm"
import { CpuProfile } from "../cpu-profile"
import path from "node:path"

export type Input<Value> =
  Value extends Spec.Node<infer _Name, infer Command, infer _Commands>
    ? Input<Command>
    : Value extends Command.Command<infer _Name, infer Input, infer _Context, infer _Error, infer _Requirements>
      ? Input
      : never

type RuntimeHandler = (
  input: unknown,
) => Effect.Effect<
  void,
  unknown,
  FileSystem.FileSystem | Global.Service | Npm.Service | Updater.Service | Config.Service | Scope.Scope
>
type Loader<Node extends Spec.Any> = () => Promise<{
  default: (
    input: Input<Node>,
  ) => Effect.Effect<
    void,
    any,
    FileSystem.FileSystem | Global.Service | Npm.Service | Updater.Service | Config.Service | Scope.Scope
  >
}>
type ProvidedCommand = Command.Command<
  string,
  unknown,
  unknown,
  unknown,
  FileSystem.FileSystem | Global.Service | Npm.Service | Updater.Service | Config.Service | Scope.Scope
>

export type Handlers<Node extends Spec.Any> = keyof Node["commands"] extends never
  ? Loader<Node>
  : { readonly $?: Loader<Node> } & { readonly [Key in keyof Node["commands"]]: Handlers<Node["commands"][Key]> }

interface LazyHandler {
  readonly spec: Command.Command.Any
  readonly load: () => Promise<{ default: RuntimeHandler }>
}

type RuntimeHandlers =
  | (() => Promise<{ default: RuntimeHandler }>)
  | {
      readonly $?: () => Promise<{ default: RuntimeHandler }>
      readonly [key: string]: RuntimeHandlers | (() => Promise<{ default: RuntimeHandler }>) | undefined
    }

export function handler<const Node extends Spec.Any, Error, Requirements>(
  _node: Node,
  run: (input: Input<Node>) => Effect.Effect<void, Error, Requirements>,
) {
  return run
}

export function handlers<const Root extends Spec.Any>(root: Root, handlers: Handlers<Root>) {
  const result: LazyHandler[] = []

  function add(node: Spec.Any, value: RuntimeHandlers) {
    if (typeof value === "function") {
      result.push({ spec: node.spec, load: value as () => Promise<{ default: RuntimeHandler }> })
      for (const alias of node.aliases)
        result.push({ spec: alias.spec, load: value as () => Promise<{ default: RuntimeHandler }> })
      return
    }
    if (value.$) {
      result.push({ spec: node.spec, load: value.$ as () => Promise<{ default: RuntimeHandler }> })
      for (const alias of node.aliases)
        result.push({ spec: alias.spec, load: value.$ as () => Promise<{ default: RuntimeHandler }> })
    }
    for (const [name, child] of Object.entries(node.commands)) add(child, value[name] as RuntimeHandlers)
  }

  add(root, handlers as RuntimeHandlers)
  return result
}

export function run(commands: Spec.Any, handlers: ReadonlyArray<LazyHandler>, options: { readonly version: string }) {
  return Command.run(provide(commands, handlers).pipe(Command.withGlobalFlags([PrintLogs, ...GlobalFlags.all])), options) as Effect.Effect<
    void,
    unknown,
    Command.Environment
  >
}

export function resolveCpuProfileTarget(
  command: string,
  flag: Option.Option<string>,
  inherited = CpuProfile.inheritedTarget(),
) {
  return Option.getOrUndefined(flag) ?? (command === "serve" ? inherited : undefined)
}

export function withCpuProfile<A, E, R>(
  command: string,
  flag: Option.Option<string>,
  effect: Effect.Effect<A, E, R>,
) {
  const profile = resolveCpuProfileTarget(command, flag)
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previousTarget = process.env[CpuProfile.targetEnvironment]
      const previousSource = process.env[CpuProfile.sourceEnvironment]
      const target = profile ? path.resolve(profile) : undefined
      if (target === undefined) {
        delete process.env[CpuProfile.targetEnvironment]
        delete process.env[CpuProfile.sourceEnvironment]
      } else {
        process.env[CpuProfile.targetEnvironment] = target
        process.env[CpuProfile.sourceEnvironment] = CpuProfile.explicitSource
      }
      return { target, previousTarget, previousSource }
    }),
    ({ target }) => (target !== undefined && command === "serve" ? CpuProfile.run(target, effect) : effect),
    ({ previousTarget, previousSource }) =>
      Effect.sync(() => {
        if (previousTarget === undefined) delete process.env[CpuProfile.targetEnvironment]
        else process.env[CpuProfile.targetEnvironment] = previousTarget
        if (previousSource === undefined) delete process.env[CpuProfile.sourceEnvironment]
        else process.env[CpuProfile.sourceEnvironment] = previousSource
      }),
  )
}

function provide(node: Spec.Any, handlers: ReadonlyArray<LazyHandler>): ProvidedCommand {
  const handler = handlers.find((handler) => handler.spec === node.spec)
  const spec = handler
    ? node.spec.pipe(
        Command.withHandler((input) =>
          Effect.gen(function* () {
            if (yield* PrintLogs) process.env.OPENCODE_PRINT_LOGS = "1"
            const flag = yield* GlobalFlags.CpuProfile
            return yield* withCpuProfile(
              node.name,
              flag,
              Effect.gen(function* () {
                const module = yield* Effect.promise(handler.load)
                return yield* module.default(input)
              }),
            )
          }),
        ),
      )
    : node.spec
  if (!Object.keys(node.commands).length) return spec as ProvidedCommand
  const children = Object.values(node.commands)
  return spec.pipe(
    Command.withSubcommands([
      ...children.map((child) => provide(child, handlers)),
      ...children.flatMap((child) => child.aliases.map((alias) => provide(alias, handlers))),
    ]),
  ) as ProvidedCommand
}

export * as Runtime from "./runtime"
