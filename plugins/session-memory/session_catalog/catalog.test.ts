import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../index"
import { loadSessionCatalog } from "./catalog"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      for (let attempt = 0; ; attempt++) {
        try {
          await rm(directory, { recursive: true, force: true })
          return
        } catch (error) {
          if (attempt === 4) throw error
          await Bun.sleep(25 * 2 ** attempt)
        }
      }
    }),
  )
})

async function catalogFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "session-memory-catalog-"))
  temporaryDirectories.push(directory)
  const databasePath = path.join(directory, "opencode.db")
  const db = new Database(databasePath)
  db.run(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    title TEXT,
    time_updated INTEGER NOT NULL
  )`)
  const insert = db.prepare("INSERT INTO session_v2 (id, parent_id, title, time_updated) VALUES (?, ?, ?, ?)")
  insert.run("ses_current", null, "Current", 400)
  insert.run("ses_newest", null, "Newest", 300)
  insert.run("ses_untitled", null, null, 200)
  insert.run("ses_oldest", null, "Oldest", 100)
  insert.run("ses_child", "ses_newest", "Child", 350)
  insert.finalize()
  db.close()
  return databasePath
}

describe("session catalog input contract", () => {
  test("projects nullable titles and preserves valid keyset pagination", async () => {
    const databasePath = await catalogFixture()
    const first = loadSessionCatalog(databasePath, { currentSessionID: "ses_current", limit: 1 })
    expect(first.sessions).toEqual([{ session_id: "ses_newest", title: "Newest" }])
    expect(first.next_cursor).toBeString()

    const second = loadSessionCatalog(databasePath, {
      currentSessionID: "ses_current",
      limit: 1,
      cursor: first.next_cursor,
    })
    expect(second.sessions).toEqual([{ session_id: "ses_untitled", title: "Untitled" }])
    expect(second.next_cursor).toBeString()
  })

  test("treats explicit null as terminal without restarting the catalog", async () => {
    const result = loadSessionCatalog(await catalogFixture(), {
      currentSessionID: "ses_current",
      cursor: null,
    })
    expect(result).toMatchObject({
      root_session_count: 3,
      returned_session_count: 0,
      sessions: [],
      next_cursor: null,
      cursor_end: true,
    })
  })

  test("locally omits an unsupported title instead of rejecting the page", async () => {
    const databasePath = await catalogFixture()
    const db = new Database(databasePath)
    const insert = db.prepare("INSERT INTO session_v2 (id, parent_id, title, time_updated) VALUES (?, ?, ?, ?)")
    insert.run("ses_control_title", null, "title\0\u0001", 350)
    insert.finalize()
    db.close()

    const result = loadSessionCatalog(databasePath, { currentSessionID: "ses_current" })
    expect(result.sessions).toContainEqual({
      session_id: "ses_control_title",
      title: "[OMITTED:unsupported-text]",
    })
    expect(result.redacted_count).toBeGreaterThanOrEqual(1)
  })

  test("returns a recoverable result for malformed or non-string cursors", async () => {
    const databasePath = await catalogFixture()
    for (const cursor of ["null", "%%%", 42]) {
      const result = loadSessionCatalog(databasePath, { currentSessionID: "ses_current", cursor })
      expect(result.sessions).toEqual([])
      expect(result.next_cursor).toBeNull()
      expect(result.cursor_error).toMatchObject({ code: "invalid_cursor" })
      expect(result.cursor_error?.recovery).toContain("without cursor")
    }
  })

  test("advertises the terminal cursor and accepts a null Tool input object", async () => {
    const databasePath = await catalogFixture()
    const previousDatabase = process.env.OPENCODE_DB
    process.env.OPENCODE_DB = databasePath
    try {
      const tools = new Map<string, any>()
      const cleanup = await plugin.setup({
        app: { channel: "latest" },
        tool: {
          async transform(transform: (draft: { add(tool: any): void }) => void) {
            transform({ add: (tool) => tools.set(tool.name, tool) })
            return { dispose() {} }
          },
        },
      } as any)
      const catalog = tools.get("session_catalog")
      expect(catalog.input.properties.cursor.anyOf).toEqual([
        { type: "string", minLength: 1, maxLength: 512 },
        { type: "null" },
      ])
      expect(catalog.description).toContain("A null next_cursor means the catalog has ended")
      const result = await catalog.execute(null, {
        sessionID: "ses_current",
        async progress() {},
      })
      expect(result.output.sessions).toHaveLength(3)
      cleanup()
    } finally {
      if (previousDatabase === undefined) delete process.env.OPENCODE_DB
      else process.env.OPENCODE_DB = previousDatabase
    }
  })
})
