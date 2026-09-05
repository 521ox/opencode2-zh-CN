import { EOL } from "node:os"
import { recoveryMessage, runDrain } from "@opencode-ai/server/drain"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { OPENCODE_CHANNEL } from "../../../version"

export default Runtime.handler(
  Commands.commands.service.commands.drain,
  Effect.fn("cli.service.drain")(function* (input) {
    const result = yield* runDrain({
      path: databasePath(Option.getOrUndefined(input.database)),
      check: input.check,
    }).pipe(
      Effect.match({
        onFailure: (error) => ({ error: error.message }) as const,
        onSuccess: (value) => ({ value }) as const,
      }),
    )

    if ("error" in result) {
      process.stderr.write(result.error + EOL)
      process.exitCode = 1
      return
    }
    if (result.value.mode === "drain") {
      process.stdout.write(
        `Drained ${result.value.drained} active assistant sidecar${result.value.drained === 1 ? "" : "s"}; heads=${result.value.heads} parts=${result.value.parts}` +
          EOL,
      )
      return
    }

    process.stdout.write(
      `Active assistant sidecars: applicable=${result.value.applicable} heads=${result.value.heads} parts=${result.value.parts} violations=${result.value.violations.length}` +
        EOL,
    )
    if (result.value.violations.length === 0) return
    process.stderr.write(recoveryMessage(result.value.violations) + EOL)
    process.exitCode = 1
  }),
)

export function databasePath(
  explicit?: string,
  environment: { readonly OPENCODE_DB?: string; readonly OPENCODE_DISABLE_CHANNEL_DB?: string } = {
    OPENCODE_DB: process.env.OPENCODE_DB,
    OPENCODE_DISABLE_CHANNEL_DB: process.env.OPENCODE_DISABLE_CHANNEL_DB,
  },
  channel = OPENCODE_CHANNEL,
) {
  if (explicit) return explicit
  if (environment.OPENCODE_DB) return environment.OPENCODE_DB
  if (
    ["latest", "dev", "beta", "next", "prod"].includes(channel) ||
    environment.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    environment.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return "opencode.db"
  return `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
}
