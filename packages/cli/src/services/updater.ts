import { Context, Effect, Layer } from "effect"

export const methods = ["curl", "npm", "pnpm", "bun", "yarn"] as const
export type Method = (typeof methods)[number]

export const RELEASES_URL = "https://github.com/521ox/opencode2-zh-CN/releases"

export class DisabledError extends Error {
  override readonly name = "UpdaterDisabledError"

  constructor() {
    super(`Updates are disabled for this fork. Download a release from ${RELEASES_URL}`)
  }
}

export interface Interface {
  readonly ensureEnabled: () => Effect.Effect<void, DisabledError>
  readonly monitor: (notify: (version: string) => Effect.Effect<void>) => Effect.Effect<void>
  readonly apply: (version: string) => Effect.Effect<void, DisabledError>
  readonly method: () => Effect.Effect<Method | undefined>
  readonly latest: () => Effect.Effect<string, DisabledError>
  readonly upgrade: (method: Method, version: string) => Effect.Effect<void, DisabledError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

const rejectDisabled = () => Effect.fail(new DisabledError())

const make = Service.of({
  ensureEnabled: rejectDisabled,
  monitor: () => Effect.void,
  apply: rejectDisabled,
  method: () => Effect.succeed(undefined),
  latest: rejectDisabled,
  upgrade: rejectDisabled,
})

export const layer = Layer.succeed(Service, make)

export * as Updater from "./updater"
export { action, type Action, type Policy } from "./updater-action"
