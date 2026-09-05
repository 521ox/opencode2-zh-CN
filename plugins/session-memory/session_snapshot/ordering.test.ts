import { describe, expect, test } from "bun:test"
import { buildTimeDivisions } from "./navigation"
import { createSnapshotMessageValidation } from "./validation"
import type { SnapshotMessageLine } from "./types"

function message(id: string, time: number, line: number): SnapshotMessageLine {
  return {
    index: line - 10,
    line,
    end_line: line,
    id,
    role: "user",
    agent: null,
    summary: false,
    time_created: time,
    time_iso: new Date(time).toISOString(),
    part_count: 0,
  }
}

function validationMessage(id: string, time: number) {
  return {
    id,
    time_created: time,
    time_updated: time,
    role: "user",
    summary: false,
    agent: null,
    model: null,
    parts: [],
  }
}

describe("V2 sequence-ordered snapshots", () => {
  test("accepts non-monotonic timestamps while preserving message order and uniqueness", () => {
    const validation = createSnapshotMessageValidation()
    validation.validate(validationMessage("msg_first_by_seq", 2_000))
    validation.validate(validationMessage("msg_second_by_seq", 1_000))
    expect(() => validation.finish(2, 0)).not.toThrow()
  })

  test("still rejects duplicate message identities", () => {
    const validation = createSnapshotMessageValidation()
    validation.validate(validationMessage("msg_duplicate", 2_000))
    expect(() => validation.validate(validationMessage("msg_duplicate", 1_000))).toThrow("a unique message ID")
  })

  test("uses min/max timestamps inside contiguous sequence-ordered time divisions", () => {
    const at = (value: string) => Date.parse(value)
    const divisions = buildTimeDivisions([
      message("msg_a", at("2026-01-01T10:50:00.000Z"), 10),
      message("msg_b", at("2026-01-01T10:10:00.000Z"), 11),
      message("msg_c", at("2026-01-01T09:30:00.000Z"), 12),
      message("msg_d", at("2026-01-01T10:20:00.000Z"), 13),
    ])

    expect(divisions).toHaveLength(3)
    expect(divisions[0]).toMatchObject({
      key: "2026-01-01T10",
      start_time_iso: "2026-01-01T10:10:00.000Z",
      end_time_iso: "2026-01-01T10:50:00.000Z",
      start_line: 10,
      end_line: 11,
      message_count: 2,
      first_message_id: "msg_a",
      last_message_id: "msg_b",
    })
    expect(divisions[1]?.key).toBe("2026-01-01T09")
    expect(divisions[2]?.key).toBe("2026-01-01T10")
  })
})
