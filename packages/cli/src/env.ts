import { Config } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// Client-side password for an explicit --server target. The legacy name is
// still honored; it also remains the variable a standalone child inherits.
export const password = Config.redacted("OPENCODE_PASSWORD").pipe(
  Config.orElse(() => Config.redacted("OPENCODE_SERVER_PASSWORD")),
  Config.option,
)

// Server-side lease password: set by the standalone spawner for its child,
// or preset for a manually managed `opencode serve`.
export const serverPassword = Config.redacted("OPENCODE_SERVER_PASSWORD").pipe(Config.option)

export * as Env from "./env"
