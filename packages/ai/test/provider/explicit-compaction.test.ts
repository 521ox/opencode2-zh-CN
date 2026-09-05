import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient } from "../../src/index.js"
import { OpenAI, OpenAICompatibleResponses, XAI } from "../../src/providers.js"
import { testEffect } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"

const checkpoint = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" }

testEffect(
  dynamicResponse(({ request, text, respond }) =>
    Effect.sync(() => {
      const url = new URL(request.url)
      expect(url.pathname).toBe("/custom/responses/compact")
      expect(url.searchParams.get("trace")).toBe("route")
      expect(request.headers.authorization).toBe("Bearer test")
      expect(request.headers["x-request"]).toBe("present")
      expect(JSON.parse(text)).toEqual({
        model: "grok-fixture",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      })
      return respond(JSON.stringify({ object: "response.compaction", output: [checkpoint] }))
    }),
  ),
).effect("xAI explicit compaction uses custom endpoint, auth, query, headers, and middleware", () =>
  Effect.gen(function* () {
    const seen: string[] = []
    const model = XAI.configure({
      apiKey: "test",
      baseURL: "https://proxy.example/custom",
      headers: { "x-request": "present" },
      http: { query: { trace: "route" } },
    }).responses("grok-fixture")
    const request = LLM.request({ model, prompt: "hello" })
    expect(LLMClient.canCompact(request)).toBe(true)
    const response = yield* LLMClient.compact(request, {
      http: (request, next) => {
        seen.push(new URL(request.url).pathname)
        return next(request)
      },
    })
    expect(response.replacement[0]?.content).toEqual([
      { type: "compaction", provider: "xai", id: "cmp_1", encrypted: "opaque" },
    ])
    expect(seen).toEqual(["/custom/responses/compact"])
  }),
)

for (const body of [
  "not json",
  JSON.stringify({ object: "response.compaction", output: [] }),
  JSON.stringify({ object: "response.compaction", output: [{ type: "compaction", id: "cmp_1" }] }),
]) {
  testEffect(fixedResponse(body)).effect(`xAI compaction fails visibly for malformed output: ${body}`, () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.compact(
        LLM.request({ model: XAI.configure({ apiKey: "test" }).responses("fixture"), prompt: "hello" }),
      ).pipe(Effect.flip)
      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.reason.body).toBe(body)
      expect(error.reason.http?.status).toBe(200)
    }),
  )
}

testEffect(fixedResponse('{"error":{"message":"compact endpoint missing"}}', { status: 404 })).effect(
  "custom xAI endpoints fail visibly when compact is unavailable",
  () =>
    Effect.gen(function* () {
      const request = LLM.request({
        model: XAI.configure({ apiKey: "test", baseURL: "https://proxy.example/v1" }).responses("fixture"),
        prompt: "hello",
      })
      expect(LLMClient.canCompact(request)).toBe(true)
      const error = yield* LLMClient.compact(request).pipe(Effect.flip)
      expect(error.message).toBe("compact endpoint missing")
      expect(error.reason.http?.status).toBe(404)
    }),
)

for (const model of [
  OpenAI.configure().responses("fixture"),
  XAI.configure().chat("fixture"),
  OpenAICompatibleResponses.configure({ baseURL: "https://example.test/v1" }).model("fixture"),
]) {
  testEffect(fixedResponse("must not execute")).effect(`${model.route.id} has no explicit compact operation`, () =>
    Effect.gen(function* () {
      const request = LLM.request({ model, prompt: "hello" })
      expect(LLMClient.canCompact(request)).toBe(false)
      const error = yield* LLMClient.compact(request as unknown as Parameters<typeof LLMClient.compact>[0]).pipe(
        Effect.flip,
      )
      expect(error.reason._tag).toBe("UnsupportedOperation")
    }),
  )
}
