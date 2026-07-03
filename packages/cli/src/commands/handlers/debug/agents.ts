import { EOL } from "os"
import * as Effect from "effect/Effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "../../../services/service"

export default Runtime.handler(
  Commands.commands.debug.commands.agents,
  Effect.fn("cli.debug.agents")(function* () {
    const transport = yield* Service.connect()
    const client = createOpencodeClient({ baseUrl: transport.url, headers: transport.headers })
    const response = yield* Effect.promise(() => client.v2.agent.list({ location: { directory: process.cwd() } }))
    process.stdout.write(
      JSON.stringify(
        response.data?.data.toSorted((a, b) => a.id.localeCompare(b.id)),
        null,
        2,
      ) + EOL,
    )
  }),
)
