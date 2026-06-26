import type { GlobalEvent, OpencodeClient } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { client: OpencodeClient }) => {
    const abort = new AbortController()
    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) handler(event)
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      batch(() => {
        for (const event of events) emitter.emit("event", event)
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last
      if (timer) return
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    onMount(() => {
      void (async () => {
        let attempt = 0
        while (!abort.signal.aborted) {
          const events = await props.client.global.event({
            signal: abort.signal,
            sseMaxRetryAttempts: 0,
          })

          if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) await props.client.sync.start().catch(() => {})

          for await (const event of events.stream) {
            if (abort.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted) break
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)),
          )
        }
      })().catch(() => {})
    })

    onCleanup(() => {
      abort.abort()
      if (timer) clearTimeout(timer)
      handlers.clear()
    })

    return {
      client: props.client,
      event: emitter,
    }
  },
})
