import { describe, expect, test } from "bun:test"
import { createSessionCleaner } from "./cleaner"
import {
  assertNoUnredactedSecretsInValue,
  assertPublishableIdentity,
  OMITTED_UNSUPPORTED_TEXT,
  redactStructured,
  redactText,
} from "./redaction"
import type { HydratedMessage, JsonObject } from "./types"

function sourcePart(id: string, data: JsonObject, index: number) {
  return {
    row: {
      id,
      message_id: "msg_fixture",
      session_id: "ses_fixture",
      time_created: index + 1,
      time_updated: index + 1,
      data: JSON.stringify(data),
    },
    data,
  }
}

describe("unsupported control-content handling", () => {
  test("keeps redactText as a fail-closed detector", () => {
    const result = redactText("before\0after")
    expect(result.status).toBe("unknown")
    expect(result.failureClasses).toContain("nul-byte")
    expect(result.failureClasses).toContain("binary-like-control-content")
    expect(result.text).toContain("\0")
  })

  test("locally omits unsupported string values before publication", () => {
    const result = redactStructured({
      clean: "preserved",
      unsafe: "sk-abcdefghijklmnop\0\u0001",
    })

    expect(result.status).toBe("eligible")
    expect(result.unknownCount).toBe(0)
    expect(result.failureClasses).toEqual([])
    expect(result.categories).toContain("omitted-unsupported-text")
    expect(result.value).toEqual({
      clean: "preserved",
      unsafe: OMITTED_UNSUPPORTED_TEXT,
    })
    expect(() => assertNoUnredactedSecretsInValue(result.value)).not.toThrow()
  })

  test("replaces unsupported object keys without retaining their values", () => {
    const input = {
      ok: true,
      __omitted_key_0: "already-present",
      ["unsafe\0key"]: "sk-abcdefghijklmnop",
    }
    const result = redactStructured(input)
    const value = result.value as Record<string, unknown>

    expect(result.status).toBe("eligible")
    expect(value.ok).toBe(true)
    expect(value.__omitted_key_0).toBe("already-present")
    expect(value["unsafe\0key"]).toBeUndefined()
    expect(value.__omitted_key_1).toMatchObject({
      omitted: true,
      reason: "unsupported-object-key",
      failure_classes: ["nul-byte", "binary-like-control-content"],
      nul_count: 1,
    })
    expect(JSON.stringify(value)).not.toContain("abcdefghijklmnop")
    expect(() => assertNoUnredactedSecretsInValue(value)).not.toThrow()
  })

  test("does not make unsupported non-JSON values publishable", () => {
    const result = redactStructured({ unsupported: 1n })
    expect(result.status).toBe("unknown")
    expect(result.failureClasses).toContain("unsupported-structured-value")
  })

  test("continues to fail closed for identity fields", () => {
    expect(() => assertPublishableIdentity("msg_clean", "message.id")).not.toThrow()
    expect(() => assertPublishableIdentity("msg_bad\0id", "message.id")).toThrow(
      "Session snapshot identity is not publishable at message.id",
    )
    expect(() => assertPublishableIdentity("sk-abcdefghijklmnop", "message.id")).toThrow(
      "Session snapshot identity is not publishable at message.id",
    )
  })

  test("sanitizes text, compaction, and unknown parts as one clean message", () => {
    const message: HydratedMessage = {
      row: {
        id: "msg_fixture",
        session_id: "ses_fixture",
        time_created: 1,
        time_updated: 1,
        data: "{}",
      },
      data: { role: "user", summary: false, model: { name: "model\0name" } },
      parts: [
        sourcePart("part_text", { type: "text", text: "text\0payload" }, 0),
        sourcePart("part_compaction", { type: "compaction", summary: "summary\0payload" }, 1),
        sourcePart("part_unknown", { type: "widget", payload: { value: "value\0payload" } }, 2),
      ],
    }
    const cleaner = createSessionCleaner()
    const cleaned = cleaner.clean(message)
    expect(cleaned).not.toBeNull()

    const result = redactStructured(cleaned)
    const value = result.value as {
      model: { name: { omitted: boolean; reason: string } }
      parts: Array<{ text?: string; data?: Record<string, any> }>
    }
    expect(result.status).toBe("eligible")
    expect(value.model.name).toMatchObject({ omitted: true, reason: "binary-like-tool-content" })
    expect(value.parts[0]?.text).toBe(OMITTED_UNSUPPORTED_TEXT)
    expect(value.parts[1]?.data?.summary).toMatchObject({ omitted: true, reason: "binary-like-tool-content" })
    expect(value.parts[2]?.data?.payload?.value).toMatchObject({ omitted: true, reason: "binary-like-tool-content" })
    expect(() => assertNoUnredactedSecretsInValue(value)).not.toThrow()
  })

  test("sanitizes large structured values before compact previews are serialized", () => {
    const unsafeKey = "unsafe\0key"
    const message: HydratedMessage = {
      row: {
        id: "msg_large_fixture",
        session_id: "ses_fixture",
        time_created: 1,
        time_updated: 1,
        data: "{}",
      },
      data: {
        role: "user",
        summary: false,
        model: {
          [unsafeKey]: "model-value-must-not-survive",
          padding: "m".repeat(5 * 1024),
        },
      },
      parts: [
        sourcePart(
          "part_large_unknown",
          {
            type: "widget",
            [unsafeKey]: "part-value-must-not-survive",
            padding: "p".repeat(9 * 1024),
          },
          0,
        ),
      ],
    }
    const cleaner = createSessionCleaner()
    const cleaned = cleaner.clean(message)
    expect(cleaned).not.toBeNull()
    const serialized = JSON.stringify(cleaned)

    expect(serialized).not.toContain("model-value-must-not-survive")
    expect(serialized).not.toContain("part-value-must-not-survive")
    expect(serialized).not.toContain("unsafe\\u0000key")
    const result = redactStructured(cleaned)
    expect(result.status).toBe("eligible")
    expect(() => assertNoUnredactedSecretsInValue(result.value)).not.toThrow()
  })

  test("removes semantic credential fields before bounded previews lose their key context", () => {
    const message: HydratedMessage = {
      row: {
        id: "msg_sensitive_fixture",
        session_id: "ses_fixture",
        time_created: 1,
        time_updated: 1,
        data: "{}",
      },
      data: {
        role: "user",
        summary: false,
        model: {
          padding: "m".repeat(5 * 1024),
          access_token: `MODEL_SECRET_HEAD_${"z".repeat(9 * 1024)}_MODEL_SECRET_TAIL`,
        },
      },
      parts: [
        sourcePart(
          "part_password",
          {
            type: "widget",
            padding: "p".repeat(9 * 1024),
            password: `PART_SECRET_HEAD_${"q".repeat(9 * 1024)}_PART_SECRET_TAIL`,
          },
          0,
        ),
        sourcePart(
          "part_api_key",
          {
            type: "widget",
            padding: "r".repeat(9 * 1024),
            api_key: `API_SECRET_HEAD_${"v".repeat(9 * 1024)}_API_SECRET_TAIL`,
          },
          1,
        ),
      ],
    }
    const cleaner = createSessionCleaner()
    const cleaned = cleaner.clean(message)
    expect(cleaned).not.toBeNull()
    const serialized = JSON.stringify(cleaned)

    for (const marker of [
      "MODEL_SECRET_HEAD",
      "MODEL_SECRET_TAIL",
      "PART_SECRET_HEAD",
      "PART_SECRET_TAIL",
      "API_SECRET_HEAD",
      "API_SECRET_TAIL",
    ]) {
      expect(serialized).not.toContain(marker)
    }
    expect(cleaned?.model).toMatchObject({ omitted: true, reason: "unsupported-object-key" })
    expect(cleaned?.parts[0]?.data).toMatchObject({ omitted: true, reason: "unsupported-object-key" })
    expect(cleaned?.parts[1]?.data).toMatchObject({ omitted: true, reason: "unsupported-object-key" })
    const result = redactStructured(cleaned)
    expect(result.status).toBe("eligible")
    expect(() => assertNoUnredactedSecretsInValue(result.value)).not.toThrow()
  })
})
