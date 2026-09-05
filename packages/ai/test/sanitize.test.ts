import { describe, expect, test } from "bun:test"
import { sanitizeSurrogates } from "../src/utils/sanitize.js"

describe("sanitizeSurrogates", () => {
  test("isolates clean request-like object graphs", () => {
    const input = {
      model: {
        id: "gpt-5",
        route: {
          provider: "openai",
          headers: { authorization: "Bearer test" },
        },
      },
      messages: Array.from({ length: 1_000 }, (_, index) => ({
        role: "user",
        content: `message ${index}`,
        metadata: { index, tags: ["request", "clean"] },
      })),
      providerOptions: { store: false, nested: { enabled: true } },
    }

    expect(sanitizeSurrogates(undefined)).toBeUndefined()
    expect(sanitizeSurrogates(null)).toBeNull()
    expect(sanitizeSurrogates(1)).toBe(1)
    expect(sanitizeSurrogates("well formed \u{1F600}")).toBe("well formed \u{1F600}")
    const output = sanitizeSurrogates(input)

    expect(output).not.toBe(input)
    expect(output.model).not.toBe(input.model)
    expect(output.messages).not.toBe(input.messages)
    expect(output.messages[0]).not.toBe(input.messages[0])
    expect(output.providerOptions).not.toBe(input.providerOptions)
  })

  test("sanitizes a deep change without mutating the source", () => {
    const unchanged = { shared: ["clean"] }
    const input = {
      first: unchanged,
      nested: { items: ["before", { value: "bad \uD800" }, "after"] },
      last: unchanged,
    }

    const output = sanitizeSurrogates(input)

    expect(output).not.toBe(input)
    expect(output.first).not.toBe(unchanged)
    expect(output.last).not.toBe(unchanged)
    expect(output.nested).not.toBe(input.nested)
    expect(output.nested.items).not.toBe(input.nested.items)
    expect(output.nested.items[0]).toBe(input.nested.items[0])
    expect(output.nested.items[2]).toBe(input.nested.items[2])
    expect(output.nested.items[1]).not.toBe(input.nested.items[1])
    expect(output.nested.items[1]).toEqual({ value: "bad \uFFFD" })
    expect(input.nested.items[1]).toEqual({ value: "bad \uD800" })
  })

  test("sanitizes keys while retaining legacy non-ordinary behavior", () => {
    class Example {
      constructor(readonly value: string) {}
    }
    const date = new Date("2026-01-01T00:00:00.000Z")
    const typed = new Uint16Array([1, 2])
    const input = {
      stable: { value: "clean" },
      "bad \uD800": { nested: "bad \uDC00" },
      date,
      typed,
      example: new Example("bad \uD800"),
      bytes: new Uint8Array([1, 2]),
      error: new Error("bad \uD800"),
    }

    const output = sanitizeSurrogates(input)

    expect(output.stable).not.toBe(input.stable)
    expect(output["bad \uFFFD"]).toEqual({ nested: "bad \uFFFD" })
    expect(output).not.toHaveProperty("bad \uD800")
    expect(output.date).toEqual({})
    expect(output.typed).toEqual({ 0: 1, 1: 2 })
    expect(output.example).toEqual({ value: "bad \uFFFD" })
    expect(output.bytes).toBe(input.bytes)
    expect(output.error).toBe(input.error)
    expect(input["bad \uD800"].nested).toBe("bad \uDC00")
    expect(input.example).toBeInstanceOf(Example)
  })
})
