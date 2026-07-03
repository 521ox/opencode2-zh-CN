import { Effect } from "effect"
import * as service from "./index.js"

export type { Transport, Discover, Registration, LocalService, ServiceOptions } from "./index.js"

export { basicAuth } from "./index.js"

export const readRegistration = (file?: string) => Effect.promise(() => service.readRegistration(file))
export const discover = (options?: service.ServiceOptions) => Effect.promise(() => service.discover(options))
export const stop = (options?: service.ServiceOptions) => Effect.promise(() => service.stop(options))
export const start = (options?: service.ServiceOptions) =>
  Effect.tryPromise({
    try: () => service.start(options),
    catch: (cause) => new Error("Failed to start server", { cause }),
  })
export const connect = (options?: service.ServiceOptions) =>
  Effect.tryPromise({
    try: () => service.connect(options),
    catch: (cause) => new Error("Failed to connect to server", { cause }),
  })

export * as ServiceEffect from "./effect.js"
