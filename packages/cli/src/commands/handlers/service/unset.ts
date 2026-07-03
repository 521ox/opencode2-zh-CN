import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "../../../services/service"

export default Runtime.handler(
  Commands.commands.service.commands.unset,
  Effect.fn("cli.service.unset")(function* (input) {
    yield* Service.unset(input.key)
  }),
)
