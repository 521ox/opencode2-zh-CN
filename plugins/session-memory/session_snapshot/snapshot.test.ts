import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OMITTED_UNSUPPORTED_TEXT } from "./redaction"
import { SessionSnapshotService } from "./snapshot"
import { validateSessionSnapshotFile } from "./validation"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function snapshotFixture(options: { unsafeToolCall?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "session-memory-snapshot-"))
  temporaryDirectories.push(directory)
  const databasePath = path.join(directory, "opencode.db")
  const db = new Database(databasePath)
  db.run(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT,
    parent_id TEXT,
    directory TEXT NOT NULL,
    path TEXT,
    title TEXT,
    version TEXT NOT NULL,
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER,
    agent TEXT,
    model TEXT
  )`)
  db.run(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`)
  const insertSession = db.prepare(`INSERT INTO session_v2 (
    id, project_id, workspace_id, parent_id, directory, path, title, version,
    share_url, summary_additions, summary_deletions, summary_files,
    time_created, time_updated, time_compacting, time_archived, agent, model
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  insertSession.run(
    "ses_fixture",
    "project_fixture",
    null,
    null,
    "/fixture",
    null,
    "title\0payload",
    "fixture",
    null,
    null,
    null,
    null,
    1_000,
    2_000,
    null,
    null,
    null,
    null,
  )
  insertSession.finalize()
  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  insertMessage.run("msg_first_by_seq", "ses_fixture", "user", 1, 2_000, 2_000, JSON.stringify({ text: "clean" }))
  insertMessage.run(
    "msg_second_by_seq",
    "ses_fixture",
    "user",
    2,
    1_000,
    1_000,
    JSON.stringify({
      text: "sk-abcdefghijklmnop\0\u0001",
      model: {
        padding: "m".repeat(5 * 1024),
        password: `MODEL_SECRET_HEAD_${"z".repeat(9 * 1024)}_MODEL_SECRET_TAIL`,
      },
      files: [
        {
          type: "widget",
          ["unsafe-part\0key"]: "part-value-must-not-survive",
          padding: "p".repeat(9 * 1024),
        },
        {
          type: "widget",
          padding: "r".repeat(9 * 1024),
          api_key: `API_SECRET_HEAD_${"v".repeat(9 * 1024)}_API_SECRET_TAIL`,
        },
      ],
    }),
  )
  if (options.unsafeToolCall) {
    insertMessage.run(
      "msg_tool_identity",
      "ses_fixture",
      "assistant",
      3,
      3_000,
      3_000,
      JSON.stringify({
        content: [
          {
            type: "tool",
            id: "call_bad\0id",
            name: "shell",
            state: { status: "completed", input: { command: "echo safe" } },
          },
        ],
      }),
    )
  }
  insertMessage.finalize()
  db.close()

  const service = new SessionSnapshotService({
    databasePath,
    approvedTempBase: directory,
    snapshotRoot: path.join(directory, "snapshots"),
  })
  return { service }
}

describe("session snapshot compatibility", () => {
  test("publishes a validated snapshot for control content and sequence-ordered timestamps", async () => {
    const { service } = await snapshotFixture()
    const result = await service.create("ses_fixture")
    try {
      const validation = await validateSessionSnapshotFile(result.path)
      const document = JSON.parse(await readFile(result.path, "utf8"))

      expect(validation.message_count).toBe(2)
      expect(validation.time_span).toMatchObject({ start_time: 1_000, end_time: 2_000 })
      expect(document.session.title).toBe(OMITTED_UNSUPPORTED_TEXT)
      expect(document.messages[0].id).toBe("msg_first_by_seq")
      expect(document.messages[1].id).toBe("msg_second_by_seq")
      expect(document.messages[1].parts[0].text).toBe(OMITTED_UNSUPPORTED_TEXT)
      const serialized = JSON.stringify(document)
      expect(serialized).not.toContain("part-value-must-not-survive")
      expect(serialized).not.toContain("unsafe-part\\u0000key")
      expect(serialized).not.toContain("MODEL_SECRET_HEAD")
      expect(serialized).not.toContain("MODEL_SECRET_TAIL")
      expect(serialized).not.toContain("API_SECRET_HEAD")
      expect(serialized).not.toContain("API_SECRET_TAIL")
      expect(document.snapshot.redaction.status).toBe("eligible")
      expect(document.snapshot.redaction.unknownCount).toBe(0)
      expect(document.snapshot.redaction.failureClasses).toEqual([])
    } finally {
      const cleanup = await service.cleanup("ses_fixture")
      expect(cleanup.deleted).toBe(true)
    }
  })

  test("fails closed when a projected tool-call identity contains unsupported controls", async () => {
    const { service } = await snapshotFixture({ unsafeToolCall: true })
    let failure: unknown
    try {
      await service.create("ses_fixture")
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("Session snapshot identity is not publishable at part.call_id")
    const cleanup = await service.cleanup("ses_fixture")
    expect(cleanup.deleted).toBe(false)
    expect(cleanup.removed_directories).toBe(0)
  })
})
