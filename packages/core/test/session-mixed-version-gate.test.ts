import { describe, expect, test } from "bun:test"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { EffectDrizzleSqlite } from "@opencode-ai/core/database/drizzle"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Model } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageProjection } from "@opencode-ai/core/session/message-projection"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionAssistantActiveTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Global } from "@opencode-ai/util/global"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const model = Model.Ref.make({ id: Model.ID.make("gate"), providerID: Provider.ID.make("synthetic") })
const agent = Agent.ID.make("build")

describe("mixed-version active assistant startup gate", () => {
  test("an old-format database is not applicable without touching absent sidecar tables", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        return yield* SessionMessageProjection.checkActiveIntegrity(db)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
    expect(result).toEqual({ applicable: false, heads: 0, parts: 0, violations: [] })
  })

  test("migrated empty and valid active databases pass without mutation and Session.node builds", async () => {
    await using tmp = await tmpdir("opencode-sidecar-gate-")
    const empty = path.join(tmp.path, "empty.sqlite")
    expect(await checkFile(empty)).toEqual({ applicable: true, heads: 0, parts: 0, violations: [] })
    await expect(buildSession(empty)).resolves.toBeUndefined()

    const active = path.join(tmp.path, "active.sqlite")
    await seedActive(active)
    const before = await sidecarSnapshot(active)
    expect(await checkFile(active)).toEqual({ applicable: true, heads: 1, parts: 1, violations: [] })
    await expect(buildSession(active)).resolves.toBeUndefined()
    expect(await sidecarSnapshot(active)).toEqual(before)
  })

  for (const variant of ["nonempty", "completed"] as const) {
    test(`${variant} old-writer anchor is named and makes Session.node fail closed`, async () => {
      await using tmp = await tmpdir("opencode-sidecar-gate-")
      const filename = path.join(tmp.path, `${variant}.sqlite`)
      const fixture = await seedActive(filename)
      await withDatabase(filename, (db) =>
        Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.id, fixture.messageID))
            .get()
            .pipe(Effect.orDie)
          const data =
            variant === "nonempty"
              ? { ...row!.data, content: [{ type: "text", text: "old-writer" }] }
              : { ...row!.data, time: { ...row!.data.time, completed: 2 } }
          yield* db
            .update(SessionMessageTable)
            .set({ data })
            .where(eq(SessionMessageTable.id, fixture.messageID))
            .run()
            .pipe(Effect.orDie)
        }),
      )

      expect((await checkFile(filename)).violations).toContain(
        `Active assistant ${fixture.messageID} has an invalid message anchor`,
      )
      await expect(buildSession(filename)).rejects.toThrow(
        "Active assistant sidecar integrity check failed: Active assistant",
      )
      await expect(buildSession(filename)).rejects.toThrow(
        "opencode2 service drain --check --database <path> or restore a backup",
      )
    })
  }

  test("a structural Session mismatch is named and makes Session.node fail closed", async () => {
    await using tmp = await tmpdir("opencode-sidecar-gate-")
    const filename = path.join(tmp.path, "mismatch.sqlite")
    const fixture = await seedActive(filename)
    const wrong = Session.ID.make("ses_gate_wrong")
    await withDatabase(filename, (db) =>
      Effect.gen(function* () {
        yield* db
          .insert(SessionTable)
          .values({
            id: wrong,
            project_id: Project.ID.global,
            slug: "wrong",
            directory: "/project",
            title: "wrong",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionAssistantActiveTable)
          .set({ session_id: wrong })
          .where(eq(SessionAssistantActiveTable.message_id, fixture.messageID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    expect((await checkFile(filename)).violations).toContain(
      `head ${fixture.messageID} Session mismatch (${wrong} != ${fixture.sessionID})`,
    )
    await expect(buildSession(filename)).rejects.toThrow("Active assistant sidecar integrity check failed")
  })
})

function databaseNode(filename: string) {
  return Database.configured({ path: filename })
}

function projectionLayer(filename: string) {
  const database = databaseNode(filename)
  return AppNodeBuilder.build(LayerNode.group([database, Bus.node, SessionProjector.node]), [
    [Bus.node, Bus.configured({ persist: true })],
  ])
}

function sessionLayer(filename: string) {
  const database = databaseNode(filename)
  return AppNodeBuilder.build(
    LayerNode.group([database, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      [Bus.node, Bus.configured({ persist: true })],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  )
}

function buildSession(filename: string) {
  return Effect.runPromise(Effect.scoped(Layer.build(sessionLayer(filename)))).then(() => undefined)
}

function seedActive(filename: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const sessionID = Session.ID.make("ses_gate_active")
      const messageID = SessionMessage.ID.make("msg_gate_active")
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "gate",
          directory: "/project",
          title: "gate",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: messageID, agent, model })
      yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: messageID, ordinal: 0 })
      return { sessionID, messageID }
    }).pipe(Effect.provide(projectionLayer(filename)), Effect.scoped),
  )
}

function withDatabase<A>(filename: string, effect: (db: Database.Interface["db"]) => Effect.Effect<A>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* effect(db)
    }).pipe(
      Effect.provide(Database.layer({ path: filename })),
      Effect.provideService(Global.Service, Global.make({ data: path.dirname(filename) })),
      Effect.scoped,
    ),
  )
}

function checkFile(filename: string) {
  return withDatabase(filename, SessionMessageProjection.checkActiveIntegrity)
}

function sidecarSnapshot(filename: string) {
  return withDatabase(filename, (db) =>
    db
      .all<{ tableName: string; identity: string; data: string }>(
        sql`
        SELECT 'head' AS tableName, message_id AS identity, hex(CAST(data AS BLOB)) AS data
        FROM session_assistant_active
        UNION ALL
        SELECT 'part', message_id || ':' || position, hex(CAST(data AS BLOB))
        FROM session_assistant_part
        ORDER BY tableName, identity
      `,
      )
      .pipe(Effect.orDie),
  )
}
