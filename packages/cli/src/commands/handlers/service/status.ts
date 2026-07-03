import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "../../../services/service"

export default Runtime.handler(
  Commands.commands.service.commands.status,
  Effect.fn("cli.service.status")(function* () {
    const found = yield* Service.discover()
    process.stdout.write((found ? found.url : "stopped") + EOL)
  }),
)
