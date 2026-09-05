import { Effect } from "effect"

export type Operation = "check" | "update"

export class PackageOperationTimeoutError extends Error {
  override readonly name = "PackageOperationTimeoutError"

  constructor(
    readonly operation: Operation,
    readonly target: string,
  ) {
    super(`Timed out ${operation === "check" ? "checking" : "updating"} TUI plugin package after 2 minutes: ${target}`)
  }
}

export function run<A, E>(operation: Operation, target: string, effect: Effect.Effect<A, E>) {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () => Effect.fail(new PackageOperationTimeoutError(operation, target)),
    }),
  )
}

export * as PackageOperation from "./package-operation"
