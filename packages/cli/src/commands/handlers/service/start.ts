import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "../../../services/service"

export default Runtime.handler(
  Commands.commands.service.commands.start,
  Effect.fn("cli.service.start")(function* () {
    process.stdout.write((yield* Service.start()).url + EOL)
  }),
)
