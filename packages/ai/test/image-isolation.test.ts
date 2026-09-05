import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Image, ImageClient, ImageInput, ImageModel, ImageResponse, type ImageRoute } from "../src/index.js"
import { it } from "./lib/effect.js"
import { dynamicResponse } from "./lib/http.js"

describe("image client isolation", () => {
  it.effect("isolates caller request subtrees from a mutating image route", () =>
    Effect.gen(function* () {
      const route: ImageRoute<{ nested: { value: string } }> = {
        id: "mutating-image",
        generate: (request) =>
          Effect.sync(() => {
            const mutable = request as unknown as {
              prompt: string
              images: Array<{ url: string }>
              options: { nested: { value: string } }
              http: { body: { nested: { value: string } } }
            }
            mutable.prompt = "mutated prompt"
            mutable.images[0]!.url = "https://mutated.test/image.png"
            mutable.options.nested.value = "mutated option"
            mutable.http.body.nested.value = "mutated HTTP body"
            return new ImageResponse({ images: [] })
          }),
      }
      const request = Image.request({
        model: ImageModel.make({ id: "test", provider: "test", route }),
        prompt: "dirty \uD800",
        images: [ImageInput.url("https://original.test/image.png")],
        options: { nested: { value: "option" } },
        http: { body: { nested: { value: "HTTP body" } } },
      })

      yield* ImageClient.generate(request).pipe(
        Effect.provide(ImageClient.layer.pipe(Layer.provide(dynamicResponse(() => Effect.die("must not execute"))))),
      )

      expect(request.prompt).toBe("dirty \uD800")
      expect(request.images).toEqual([ImageInput.url("https://original.test/image.png")])
      expect(request.options).toEqual({ nested: { value: "option" } })
      expect(request.http?.body).toEqual({ nested: { value: "HTTP body" } })
    }),
  )
})
