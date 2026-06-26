import { createMemo } from "solid-js"
import { useData } from "../context/data"
import { useSync } from "../context/sync"

export function useConnected() {
  const data = useData()
  const sync = useSync()
  return createMemo(
    () =>
      (data.location.integration.list() ?? []).some((integration) => integration.connections.length > 0) ||
      sync.data.console_state.consoleManagedProviders.length > 0,
  )
}
