import type { V2Event } from "@opencode-ai/sdk/v2"
import { useSDK } from "./sdk"

type EventMetadata = {
  directory: string | undefined
  workspace: string | undefined
}

export function useEvent() {
  const sdk = useSDK()

  function subscribe(handler: (event: V2Event, metadata: EventMetadata) => void) {
    return sdk.event.listen(({ details }) => {
      if (details.type === "server.connected") return
      handler(details, { directory: details.location?.directory, workspace: details.location?.workspaceID })
    })
  }

  function on<T extends V2Event["type"]>(
    type: T,
    handler: (event: Extract<V2Event, { type: T }>, metadata: EventMetadata) => void,
  ) {
    return sdk.event.on(type, (event) => {
      handler(event, { directory: event.location?.directory, workspace: event.location?.workspaceID })
    })
  }

  return {
    subscribe,
    on,
  }
}
