import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/core/database/drizzle"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "./fixture/tmpdir"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import legacyCredentialsMigration from "@opencode-ai/core/database/migration/20260805200742_import_legacy_credentials"
import worktreeMigration from "@opencode-ai/core/database/migration/20260812213948_worktree"
import sessionStartDirectoryMigration from "@opencode-ai/core/database/migration/20260815081049_session_start_directory"
import { Global } from "@opencode-ai/util/global"

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient | Global.Service>,
  global = Global.make({ data: path.join(process.cwd(), ".test-data") }),
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Global.Service, global),
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration", () => {
  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")

    await Effect.runPromise(
      Effect.all(
        [Database.layer({ path: filename }), Database.layer({ path: filename })].map((layer) =>
          Effect.scoped(Layer.build(layer)),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.provideService(Global.Service, Global.make({ data: tmp.path }))),
    )
  })

  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }

  test("bootstraps the current schema and records the migration registry", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'`)).toEqual(
          {
            name: "session_v2",
          },
        )
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_pending'`),
        ).toEqual({ name: "session_pending" })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: migrations.length })
      }),
    )
  })

  test("rejects a non-empty database without a session table", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE unrelated (id text PRIMARY KEY)`)
          yield* DatabaseMigration.apply(db)
        }),
      ),
    ).rejects.toThrow("Database is not empty and has no session table")
  })

  test("bootstraps alongside underscore-prefixed embedder tables", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE _embedder_state (id text PRIMARY KEY)`)
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'`)).toEqual(
          { name: "session_v2" },
        )
      }),
    )
  })

  test("applies generic migrations once and records their order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        const input = [
          {
            id: "first",
            up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
              tx.run(sql`CREATE TABLE applied (id text PRIMARY KEY)`),
          },
          {
            id: "second",
            up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
              tx.run(sql`INSERT INTO applied (id) VALUES ('second')`),
          },
        ]

        yield* DatabaseMigration.applyOnly(db, input)
        yield* DatabaseMigration.applyOnly(db, input)

        expect(yield* db.all(sql`SELECT id FROM applied`)).toEqual([{ id: "second" }])
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY time_completed, id`)).toEqual([
          { id: "first" },
          { id: "second" },
        ])
      }),
    )
  })

  test("copies project directories into worktrees without removing the old table", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE project_directory (project_id text NOT NULL, directory text NOT NULL, type text, strategy text, time_created integer NOT NULL, PRIMARY KEY (project_id, directory))`,
        )
        yield* db.run(
          sql`INSERT INTO project_directory (project_id, directory, type, strategy, time_created) VALUES ('project', '/root', 'main', NULL, 1), ('project', '/legacy', 'git_worktree', NULL, 2), ('project', '/strategy', NULL, 'git_worktree', 3), ('project', '/custom', NULL, 'acme/snapshot', 4)`,
        )

        yield* DatabaseMigration.applyOnly(db, [worktreeMigration])

        expect(yield* db.all(sql`SELECT directory, strategy FROM worktree ORDER BY directory`)).toEqual([
          { directory: "/custom", strategy: "acme/snapshot" },
          { directory: "/legacy", strategy: "git" },
          { directory: "/root", strategy: null },
          { directory: "/strategy", strategy: "git" },
        ])
        expect(yield* db.get(sql`SELECT count(*) AS count FROM project_directory`)).toEqual({ count: 4 })
      }),
    )
  })

  test("backfills immutable Session start directories only from exact persisted creation facts", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session_v2 (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE event (aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, start_directory text)`)
        const direct = path.resolve("legacy-direct-start")
        const created = path.resolve("v2-created-start")
        const oldCreated = path.resolve("v1-created-start")
        const normalize = (value: string) => (process.platform === "win32" ? value.replaceAll("\\", "/") : value)
        yield* db.run(sql`
          INSERT INTO session_v2 (id) VALUES
            ('ses_direct'), ('ses_created'), ('ses_old_created'), ('ses_invalid'), ('ses_duplicate'),
            ('ses_late'), ('ses_mismatch'), ('ses_info_mismatch'), ('ses_external')
        `)
        yield* db.run(sql`
          INSERT INTO session (id, start_directory) VALUES
            ('ses_direct', ${direct}),
            ('ses_invalid', 'relative/path')
        `)
        yield* db.run(sql`
          INSERT INTO event (aggregate_id, seq, type, data) VALUES
            ('ses_created', 0, 'session.created.1', ${JSON.stringify({ sessionID: "ses_created", location: { directory: created } })}),
            ('ses_old_created', 0, 'session.created.1', ${JSON.stringify({ sessionID: "ses_old_created", info: { id: "ses_old_created", directory: oldCreated } })}),
            ('ses_invalid', 0, 'session.created.1', ${JSON.stringify({ sessionID: "ses_invalid", location: { directory: "relative/path" } })}),
            ('ses_duplicate', 0, 'session.created.1', ${JSON.stringify({ sessionID: "ses_duplicate", location: { directory: created } })}),
            ('ses_duplicate', 0, 'session.created.1', ${JSON.stringify({ sessionID: "ses_duplicate", location: { directory: created } })}),
            ('ses_late', 1, 'session.created.1', ${JSON.stringify({ sessionID: "ses_late", location: { directory: created } })}),
            ('ses_mismatch', 0, 'session.created.1', ${JSON.stringify({ sessionID: "ses_other", location: { directory: created } })}),
            ('ses_info_mismatch', 0, 'session.created.1', ${JSON.stringify({ sessionID: "ses_info_mismatch", info: { id: "ses_other", directory: oldCreated } })}),
            ('outside', 0, 'session.created.1', ${JSON.stringify({ sessionID: "ses_external", location: { directory: created } })})
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionStartDirectoryMigration])

        expect(yield* db.all(sql`SELECT id, start_directory FROM session_v2 ORDER BY id`)).toEqual([
          { id: "ses_created", start_directory: normalize(created) },
          { id: "ses_direct", start_directory: normalize(direct) },
          { id: "ses_duplicate", start_directory: null },
          { id: "ses_external", start_directory: null },
          { id: "ses_info_mismatch", start_directory: null },
          { id: "ses_invalid", start_directory: null },
          { id: "ses_late", start_directory: null },
          { id: "ses_mismatch", start_directory: null },
          { id: "ses_old_created", start_directory: normalize(oldCreated) },
        ])
      }),
    )
  })

  test("imports legacy JSON credentials without changing the source file or existing credentials", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "auth.json")
    const content = JSON.stringify({
      openai: { type: "oauth", refresh: "refresh", access: "access", expires: 123, accountId: "account" },
      anthropic: { type: "api", key: "legacy-key", metadata: { region: "us" } },
      "https://example.com/": { type: "wellknown", key: "TOKEN", token: "wellknown-key" },
      invalid: { type: "unknown" },
    })
    await Bun.write(source, content)

    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const now = Date.now()
        yield* db.run(sql`
          INSERT INTO credential (id, integration_id, label, value, time_created, time_updated)
          VALUES ('existing', 'anthropic', 'Existing', ${JSON.stringify({ type: "key", key: "current-key" })}, ${now}, ${now})
        `)

        yield* db.run(sql`DELETE FROM migration WHERE id = ${legacyCredentialsMigration.id}`)
        yield* DatabaseMigration.applyOnly(db, [legacyCredentialsMigration])

        expect(yield* db.all(sql`SELECT integration_id, label, value FROM credential ORDER BY integration_id`)).toEqual(
          [
            {
              integration_id: "anthropic",
              label: "Existing",
              value: JSON.stringify({ type: "key", key: "current-key" }),
            },
            {
              integration_id: "https://example.com",
              label: "default",
              value: JSON.stringify({ type: "key", key: "wellknown-key" }),
            },
            {
              integration_id: "openai",
              label: "default",
              value: JSON.stringify({
                type: "oauth",
                methodID: "chatgpt-browser",
                refresh: "refresh",
                access: "access",
                expires: 123,
                metadata: { accountID: "account" },
              }),
            },
          ],
        )
        expect(yield* db.get(sql`SELECT value FROM kv WHERE key = 'wellknown:sources'`)).toEqual({
          value: JSON.stringify(["https://example.com"]),
        })
      }),
      Global.make({ data: tmp.path }),
    )

    expect(await Bun.file(source).text()).toBe(content)
  })

  test("skips legacy credential import when the source file is absent", async () => {
    await using tmp = await tmpdir()

    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${legacyCredentialsMigration.id}`)
        yield* DatabaseMigration.applyOnly(db, [legacyCredentialsMigration])

        expect(yield* db.all(sql`SELECT id FROM credential`)).toEqual([])
      }),
      Global.make({ data: tmp.path }),
    )
  })

  test("rolls back a failed migration without recording it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        const migration = {
          id: "failing",
          up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
            Effect.gen(function* () {
              yield* tx.run(sql`CREATE TABLE rolled_back (id text PRIMARY KEY)`)
              yield* Effect.fail(new Error("stop"))
            }),
        }

        expect((yield* Effect.exit(DatabaseMigration.applyOnly(db, [migration])))._tag).toBe("Failure")
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = 'failing'`)).toBeUndefined()
      }),
    )
  })

  test("suspends foreign keys outside migrations that rebuild referenced tables", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, title text NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE)`,
        )
        yield* db.run(sql`INSERT INTO session VALUES ('session', 'title')`)
        yield* db.run(sql`INSERT INTO message VALUES ('message', 'session')`)

        yield* DatabaseMigration.applyOnly(db, [
          {
            id: "rebuild",
            foreignKeys: false,
            up: (tx) =>
              Effect.gen(function* () {
                yield* tx.run(sql`CREATE TABLE next_session (id text PRIMARY KEY, title text)`)
                yield* tx.run(sql`INSERT INTO next_session SELECT * FROM session`)
                yield* tx.run(sql`DROP TABLE session`)
                yield* tx.run(sql`ALTER TABLE next_session RENAME TO session`)
              }),
          },
        ])

        expect(yield* db.get(sql`SELECT id FROM message`)).toEqual({ id: "message" })
        expect(yield* db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
      }),
    )
  })

  test("imports an existing Drizzle migration journal once", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, 'legacy', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "legacy" }])

        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(sql`UPDATE __drizzle_migrations SET name = 'ignored'`)
        yield* DatabaseMigration.applyOnly(db, [])
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }, { id: "legacy" }])
      }),
    )
  })
})
