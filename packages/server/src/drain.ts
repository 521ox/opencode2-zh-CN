import { Database } from "@opencode-ai/core/database/database"
import { SessionMessageProjection } from "@opencode-ai/core/session/message-projection"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Cause, Effect, Layer, Schema, Scope } from "effect"

export class DrainError extends Schema.TaggedError<DrainError>()("ServerDrainError", {
  message: Schema.String,
}) {}

export type CheckResult = SessionMessageProjection.SidecarIntegrityResult & { readonly mode: "check" }
export type DrainResult = SessionMessageProjection.DrainResult & { readonly mode: "drain" }

// This bridge is owned by the one-shot CLI command; process exit is its final native-resource boundary.
export const runDrain = Effect.fn("ServerDrain.runDrain")(function* (options: {
  readonly path?: string
  readonly check: boolean
}) {
  const effect = Effect.gen(function* () {
    const { db } = yield* Database.Service
    const integrity = yield* SessionMessageProjection.checkActiveIntegrity(db)
    if (options.check) return { mode: "check" as const, ...integrity }
    if (integrity.violations.length > 0) {
      return yield* new DrainError({ message: recoveryMessage(integrity.violations) })
    }
    return { mode: "drain" as const, ...(yield* SessionMessageProjection.drainActive(db)) }
  })

  const layer = LayerNode.compile(Database.configured({ path: options.path }))
  return yield* Effect.acquireUseRelease(
    Scope.make(),
    (scope) =>
      Layer.buildWithScope(layer, scope).pipe(Effect.flatMap((context) => effect.pipe(Effect.provide(context)))),
    (scope, exit) => Scope.close(scope, exit),
  ).pipe(Effect.catchCause((cause) => Effect.fail(toDrainError(cause))))
})

export function recoveryMessage(violations: readonly string[]) {
  return `Cannot drain active assistant sidecars: ${violations.join("; ")}. Stop all OpenCode processes and restore or rebuild the affected Session projection before retrying.`
}

function toDrainError(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  if (error instanceof DrainError) return error
  return new DrainError({
    message: error instanceof Error ? error.message : "Active assistant sidecar operation failed",
  })
}
