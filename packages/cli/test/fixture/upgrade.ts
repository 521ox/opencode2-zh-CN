import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { Commands } from "../../src/commands/commands"
import upgrade from "../../src/commands/handlers/upgrade"
import { Updater } from "../../src/services/updater"

await Effect.runPromise(
  Command.runWith(Commands.commands.upgrade.spec.pipe(Command.withHandler(upgrade)), { version: "test" })(
    process.argv.slice(2),
  ).pipe(
    Effect.provideService(Updater.Service, {
      ensureEnabled: () => Effect.fail(new Updater.DisabledError()),
      monitor: () => Effect.die("Manual upgrades must not monitor automatic updates"),
      apply: () => Effect.die("Manual upgrades must not apply TUI updates"),
      method: () => Effect.die("Disabled upgrades must not detect an installation method"),
      latest: () => Effect.die("Disabled upgrades must not resolve a release"),
      upgrade: () => Effect.die("Disabled upgrades must not execute an installation"),
    }),
    Effect.provide(NodeServices.layer),
  ),
)
