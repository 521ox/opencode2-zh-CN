import { EventV2 } from "@opencode-ai/core/event"
import { PublicEventManifest } from "@opencode-ai/core/public-event-manifest"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"

function eventData(data: unknown): Sse.Event {
  const event = data as EventV2.Payload
  const definition = PublicEventManifest.Latest.get(event.type)
  const encoded = definition
    ? {
        ...event,
        data: Schema.encodeUnknownSync(definition.data as Schema.Codec<unknown, unknown, never, never>)(event.data),
      }
    : event
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(encoded),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        return HttpServerResponse.stream(
          Stream.make(connected).pipe(
            Stream.concat(events.all()),
            Stream.map(eventData),
            Stream.pipeThroughChannel(Sse.encode()),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
