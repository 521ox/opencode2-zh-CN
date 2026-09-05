import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigCompaction } from "../src/config/compaction.js"
import { SessionEvent } from "../src/session-event.js"
import { SessionMessage } from "../src/session-message.js"

test("compaction configuration preserves prune and omits it when absent", () => {
  const decode = Schema.decodeUnknownSync(ConfigCompaction.Info)
  const encode = Schema.encodeSync(ConfigCompaction.Info)

  expect(encode(decode({ prune: true }))).toEqual({ prune: true })
  expect(encode(decode({}))).toEqual({})
})

test("remote compaction checkpoints retain opaque JSON items", () => {
  const checkpoint = Schema.decodeUnknownSync(SessionMessage.RemoteCompactionItem)({
    type: "compaction",
    encrypted_content: "opaque-checkpoint",
    metadata: { source: "provider" },
  })

  expect(SessionMessage.RemoteCompactionItem.ast.annotations?.identifier).toBe("Session.Message.RemoteCompactionItem")
  expect(Schema.encodeSync(SessionMessage.RemoteCompactionItem)(checkpoint)).toEqual({
    type: "compaction",
    encrypted_content: "opaque-checkpoint",
    metadata: { source: "provider" },
  })
  expect(() => Schema.decodeUnknownSync(SessionMessage.RemoteCompactionItem)({ encrypted_content: "missing-type" })).toThrow()

  const running = Schema.decodeUnknownSync(SessionMessage.CompactionRunning)({
    id: "msg_compaction",
    type: "compaction",
    status: "running",
    reason: "auto",
    summary: "",
    recent: "",
    remote: [checkpoint],
    time: { created: 0 },
  })
  const completed = Schema.decodeUnknownSync(SessionMessage.CompactionCompleted)({
    id: "msg_compaction",
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "summary",
    recent: "recent",
    remote: [checkpoint],
    time: { created: 0 },
  })

  expect(running.remote).toEqual([checkpoint])
  expect(completed.remote).toEqual([checkpoint])
  expect(
    Schema.decodeUnknownSync(SessionEvent.Compaction.Started.data)({
      sessionID: "ses_compaction",
      reason: "auto",
      recent: "",
      remote: true,
    }),
  ).toMatchObject({ remote: true })
  expect(
    Schema.decodeUnknownSync(SessionEvent.Compaction.RemoteItem.data)({
      sessionID: "ses_compaction",
      reset: true,
      item: checkpoint,
    }),
  ).toMatchObject({ reset: true, item: checkpoint })
})
