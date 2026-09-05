import { expect } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, LLMClient } from "../src/index.js"
import { XAI } from "../src/providers.js"
import { testEffect } from "./lib/effect.js"
import { runtimeLayer } from "./lib/http.js"

testEffect(runtimeLayer(FetchHttpClient.layer)).live("xAI compaction uses the configured HTTP responses endpoint", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const url = new URL(request.url)
            calls.push(url.pathname)
            expect(request.method).toBe("POST")
            expect(request.headers.get("authorization")).toBe("Bearer fixture")
            expect(url.searchParams.get("trace")).toBe("route")
            const body = await request.json()
            expect(body).toEqual({
              model: "grok-fixture",
              input: [{ role: "user", content: [{ type: "input_text", text: "original" }] }],
              instructions: "system",
            })
            return Response.json({
              object: "response.compaction",
              output: [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }],
            })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const model = XAI.configure({
      apiKey: "fixture",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      http: { query: { trace: "route" } },
    }).responses("grok-fixture")
    const result = yield* LLMClient.compact(LLM.request({ model, prompt: "original", system: "system" }))
    expect(result.replacement[0]?.content).toEqual([
      { type: "compaction", provider: "xai", id: "cmp_1", encrypted: "opaque" },
    ])
    expect(calls).toEqual(["/v1/responses/compact"])
  }),
)
