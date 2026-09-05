import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { access, rename } from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import { databasePath } from "../src/commands/handlers/service/drain"
import { tmpdir } from "./fixture/tmpdir"

describe("service drain", () => {
  test("checks a migrated empty database without mutation", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "empty.db")
    const first = await cli(["service", "drain", "--database", file, "--check"], directory.path)
    const before = snapshot(file)
    const second = await cli(["service", "drain", "--database", file, "--check"], directory.path)

    expect(first).toEqual({
      stdout: `Active assistant sidecars: applicable=true heads=0 parts=0 violations=0${EOL}`,
      stderr: "",
      exitCode: 0,
    })
    expect(second).toEqual(first)
    expect(snapshot(file)).toEqual(before)
    await expectUnlocked(file)
  })

  test("checks one valid active sidecar without mutation", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "check.db")
    await cli(["service", "drain", "--database", file, "--check"], directory.path)
    seedActive(file)
    const before = snapshot(file)

    expect(await cli(["service", "drain", "--database", file, "--check"], directory.path)).toEqual({
      stdout: `Active assistant sidecars: applicable=true heads=1 parts=1 violations=0${EOL}`,
      stderr: "",
      exitCode: 0,
    })
    expect(snapshot(file)).toEqual(before)
    await expectUnlocked(file)
  })

  test("drains to old-readable JSON and is idempotent", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "drain.db")
    await cli(["service", "drain", "--database", file, "--check"], directory.path)
    seedActive(file)

    expect(await cli(["service", "drain", "--database", file], directory.path)).toEqual({
      stdout: `Drained 1 active assistant sidecar; heads=0 parts=0${EOL}`,
      stderr: "",
      exitCode: 0,
    })
    const database = new Database(file)
    const rowStatement = database.query<{ data: string }, [string]>("SELECT data FROM session_message WHERE id = ?")
    const row = rowStatement.get("msg_drain")
    rowStatement.finalize()
    const countStatement = database.query<{ heads: number; parts: number }, []>(
      "SELECT (SELECT count(*) FROM session_assistant_active) AS heads, (SELECT count(*) FROM session_assistant_part) AS parts",
    )
    const counts = countStatement.get()
    countStatement.finalize()
    database.close()
    if (!row || !counts) throw new Error("Drained database rows are missing")
    expect(counts).toEqual({ heads: 0, parts: 0 })
    expect(JSON.parse(row.data)).toEqual({
      agent: "build",
      model: { id: "drain", providerID: "synthetic" },
      time: { created: 1 },
      content: [{ type: "text", text: "active" }],
    })
    expect(await cli(["service", "drain", "--database", file], directory.path)).toEqual({
      stdout: `Drained 0 active assistant sidecars; heads=0 parts=0${EOL}`,
      stderr: "",
      exitCode: 0,
    })
    await expectUnlocked(file)
  })

  test("rejects an old-writer-modified anchor without mutation", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "invalid.db")
    await cli(["service", "drain", "--database", file, "--check"], directory.path)
    seedActive(file)
    const database = new Database(file)
    database.run("UPDATE session_message SET data = ? WHERE id = ?", [
      JSON.stringify({ ...anchor(), content: [{ type: "text", text: "old-writer" }] }),
      "msg_drain",
    ])
    database.close()
    const before = snapshot(file)
    const message = `Cannot drain active assistant sidecars: Active assistant msg_drain has an invalid message anchor. Stop all OpenCode processes and restore or rebuild the affected Session projection before retrying.${EOL}`

    expect(await cli(["service", "drain", "--database", file, "--check"], directory.path)).toEqual({
      stdout: `Active assistant sidecars: applicable=true heads=1 parts=1 violations=1${EOL}`,
      stderr: message,
      exitCode: 1,
    })
    expect(snapshot(file)).toEqual(before)
    expect(await cli(["service", "drain", "--database", file], directory.path)).toEqual({
      stdout: "",
      stderr: message,
      exitCode: 1,
    })
    expect(snapshot(file)).toEqual(before)
    await expectUnlocked(file)
  })

  test("explicit database wins and defaults match server startup", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "explicit.db")
    const environment = { OPENCODE_DB: "environment.db", OPENCODE_DISABLE_CHANNEL_DB: undefined }
    expect(databasePath(file, environment, "local")).toBe(file)
    expect(databasePath(undefined, environment, "local")).toBe("environment.db")
    expect(databasePath(undefined, {}, "latest")).toBe("opencode.db")
    expect(databasePath(undefined, {}, "feature/test")).toBe("opencode-feature-test.db")
    expect(databasePath(undefined, { OPENCODE_DISABLE_CHANNEL_DB: "true" }, "local")).toBe("opencode.db")

    const inherited = path.join(directory.path, "environment.db")
    const result = await cli(["service", "drain", "--database", file, "--check"], directory.path, {
      OPENCODE_DB: inherited,
    })
    expect(result).toEqual({
      stdout: `Active assistant sidecars: applicable=true heads=0 parts=0 violations=0${EOL}`,
      stderr: "",
      exitCode: 0,
    })
    expect(await exists(inherited)).toBe(false)
    expect(await exists(file)).toBe(true)
    expect(await exists(path.join(directory.path, "state", "opencode", "service-local.json"))).toBe(false)
    await expectUnlocked(file)
  })
})

async function cli(args: string[], root: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      OPENCODE_DB: "",
      OPENCODE_PRINT_LOGS: "",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function expectUnlocked(file: string) {
  const moved = file + ".moved"
  await rename(file, moved)
  await rename(moved, file)
}

function seedActive(file: string) {
  const database = new Database(file)
  database.exec("PRAGMA foreign_keys = ON")
  database.run("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)", [
    "global",
    "/project",
    1,
    1,
    "[]",
  ])
  database.run(
    "INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["ses_drain", "global", "drain", "/project", "test", 1, 1],
  )
  database.run(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["msg_drain", "ses_drain", "assistant", 0, 1, 1, JSON.stringify({ ...anchor(), content: [] })],
  )
  database.run(
    "INSERT INTO session_assistant_active (message_id, session_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
    ["msg_drain", "ses_drain", JSON.stringify(anchor()), 1, 1],
  )
  database.run(
    "INSERT INTO session_assistant_part (message_id, position, type, type_ordinal, tool_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["msg_drain", 0, "text", 0, null, JSON.stringify({ type: "text", text: "active" }), 1, 1],
  )
  database.close()
}

function anchor() {
  return {
    agent: "build",
    model: { id: "drain", providerID: "synthetic" },
    time: { created: 1 },
  }
}

function snapshot(file: string) {
  const database = new Database(file)
  const statement = database.query(
    "SELECT 'message' AS table_name, id AS identity, data FROM session_message UNION ALL SELECT 'head', message_id, data FROM session_assistant_active UNION ALL SELECT 'part', message_id || ':' || position, data FROM session_assistant_part ORDER BY table_name, identity",
  )
  const rows = statement.all()
  statement.finalize()
  database.close()
  return rows
}

function exists(file: string) {
  return access(file).then(
    () => true,
    () => false,
  )
}
