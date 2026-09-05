import { Effect } from "effect"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import { Auth } from "../auth.js"
import { render as renderEndpoint } from "../endpoint.js"
import { Framing } from "../framing.js"
import type { HttpMiddleware, Transport, TransportPrepareInput } from "./index.js"
import * as ProviderShared from "../../protocols/shared.js"
import { mergeJsonRecords, type LLMRequest } from "../../schema/index.js"
import { RequestExecutor } from "../executor.js"

export type JsonRequestInput<Body> = TransportPrepareInput<Body>

export interface JsonRequestParts<Body = unknown> {
  readonly url: string
  readonly jsonBody: Body | Record<string, unknown>
  readonly bodyText: string
  readonly headers: Headers.Headers
}

export interface HttpPrepared<Frame> {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly framing: Framing.Definition<Frame>
  readonly middleware?: HttpMiddleware
  readonly dispatch?: RequestExecutor.HttpDispatch
}

const applyQuery = (url: string, query: Record<string, string> | undefined) => {
  if (!query) return url
  const next = new URL(url)
  Object.entries(query).forEach(([key, value]) => next.searchParams.set(key, value))
  return next.toString()
}

const bodyWithOverlay = <Body>(
  body: Body,
  request: LLMRequest,
  encodeBody: (body: Body) => string,
  finalizeBody?: HttpJsonInput<Body, unknown>["finalizeBody"],
) =>
  Effect.gen(function* () {
    if (request.http?.body === undefined && !finalizeBody) return { jsonBody: body, bodyText: encodeBody(body) }
    if (ProviderShared.isRecord(body)) {
      const overlaid = mergeJsonRecords(body, request.http?.body) ?? {}
      const finalized = finalizeBody?.(overlaid) ?? overlaid
      return { jsonBody: finalized, bodyText: ProviderShared.encodeJson(finalized) }
    }
    return yield* ProviderShared.invalidRequest("http.body can only overlay JSON object request bodies")
  })

export const jsonRequestParts = <Body>(
  input: JsonRequestInput<Body>,
  finalizeBody?: HttpJsonInput<Body, unknown>["finalizeBody"],
) =>
  Effect.gen(function* () {
    const url = applyQuery(
      renderEndpoint(input.endpoint, { request: input.request, body: input.body }).toString(),
      input.request.http?.query,
    )
    const body = yield* bodyWithOverlay(input.body, input.request, input.encodeBody, finalizeBody)
    const headers = yield* Auth.toEffect(input.auth)({
      request: input.request,
      method: "POST",
      url,
      body: body.bodyText,
      headers: Headers.fromInput({
        ...input.headers?.({ request: input.request }),
        ...input.request.http?.headers,
      }),
    })
    return { url, jsonBody: body.jsonBody, bodyText: body.bodyText, headers }
  })

const finalizeRequest = Effect.fn("HttpTransport.finalizeRequest")(function* (input: {
  readonly candidate: HttpClientRequest.HttpClientRequest
  readonly request: LLMRequest
  readonly auth: Auth.Definition
  readonly finalizeBody: NonNullable<HttpJsonInput<unknown, unknown>["finalizeBody"]>
}) {
  const web = yield* HttpClientRequest.toWeb(input.candidate).pipe(
    Effect.mapError((cause) => ProviderShared.invalidRequest("HTTP middleware produced an invalid request", cause)),
  )
  if (web.body === null) return yield* ProviderShared.invalidRequest("HTTP middleware must provide a JSON body")
  const text = yield* Effect.promise(() => web.clone().text())
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    return yield* ProviderShared.invalidRequest("HTTP middleware produced a malformed JSON body")
  }
  if (!ProviderShared.isRecord(decoded))
    return yield* ProviderShared.invalidRequest("HTTP middleware must provide a JSON object body")
  const body = ProviderShared.encodeJson(input.finalizeBody(decoded))
  const candidate = HttpClientRequest.bodyText(input.candidate, body, "application/json")
  const headers = yield* Auth.toEffect(input.auth)({
    request: input.request,
    method: candidate.method,
    url: web.url,
    body,
    headers: candidate.headers,
  })
  return HttpClientRequest.updateHeaders(candidate, () => headers)
})

export interface HttpJsonInput<_Body, Frame> {
  readonly framing: Framing.Definition<Frame>
  /** Canonicalize the final JSON body after raw overlays and before authentication. */
  readonly finalizeBody?: (body: Record<string, unknown>) => Record<string, unknown>
}

export type HttpJsonPatch<Body, Frame> = Partial<HttpJsonInput<Body, Frame>>

export interface HttpJsonTransport<Body, Frame> extends Transport<Body, HttpPrepared<Frame>, Frame> {
  readonly with: (patch: HttpJsonPatch<Body, Frame>) => HttpJsonTransport<Body, Frame>
}

export const httpJson = <Body, Frame>(input: HttpJsonInput<Body, Frame>): HttpJsonTransport<Body, Frame> => ({
  id: "http-json",
  with: (patch) => httpJson({ ...input, ...patch }),
  prepare: (prepareInput) =>
    Effect.gen(function* () {
      const parts = yield* jsonRequestParts({ ...prepareInput }, input.finalizeBody)
      const request = ProviderShared.jsonPost({
        url: parts.url,
        body: parts.bodyText,
        headers: parts.headers,
      })
      const finalizeBody = input.finalizeBody
      return {
        request,
        framing: input.framing,
        middleware: prepareInput.middleware,
        dispatch:
          finalizeBody === undefined
            ? undefined
            : (candidate) =>
                finalizeRequest({
                  candidate,
                  request: prepareInput.request,
                  auth: prepareInput.auth,
                  finalizeBody,
                }),
      }
    }),
  execute: (prepared, _request, runtime) =>
    Effect.gen(function* () {
      const response = yield* runtime.http.execute(prepared.request, prepared.middleware, prepared.dispatch)
      return {
        frames: prepared.framing.frame(RequestExecutor.responseStream(response)),
        http: RequestExecutor.responseHttp(response),
        body: prepared.framing.body,
      }
    }),
})

export const sseJson = {
  id: "http-json/sse",
  with: <Body>() => httpJson<Body, string>({ framing: Framing.sse }),
} as const
