import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "../../../services/service"

export default Runtime.handler(
  Commands.commands.service.commands.set,
  Effect.fn("cli.service.set")(function* (input) {
    yield* Service.set(input.key, input.value)
  }),
)
