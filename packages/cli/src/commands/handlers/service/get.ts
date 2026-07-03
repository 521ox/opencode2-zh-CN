import { EOL } from "os"
import { Option } from "effect"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "../../../services/service"

export default Runtime.handler(
  Commands.commands.service.commands.get,
  Effect.fn("cli.service.get")(function* (input) {
    process.stdout.write((yield* Service.get(Option.getOrUndefined(input.key))) + EOL)
  }),
)
