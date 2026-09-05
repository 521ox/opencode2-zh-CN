import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Model } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import {
  SessionAssistantActiveTable,
  SessionAssistantPartTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { Event } from "@opencode-ai/schema/event"
import { Money } from "@opencode-ai/schema/money"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
    [Bus.node, Bus.configured({ persist: true })],
  ]),
)
const model = Model.Ref.make({ id: Model.ID.make("synthetic"), providerID: Provider.ID.make("synthetic") })
const toolCycles = 4
const textPairs = 2
const durableMutationCount = toolCycles * 4 + textPairs * 2 + 1
const ephemeralCount = toolCycles * 2 + textPairs
const legacyDeltaAmplification = 21
const legacySmallCumulativeBytes = 105_151
const legacyLargeCumulativeBytes = 4_750_015
const RowBytes = Schema.Struct({ bytes: Schema.Number })
const Audit = Schema.Struct({ updateCount: Schema.Number, cumulativeBytes: Schema.Number })
const EventData = Schema.Record(Schema.String, Schema.Unknown)

describe("SessionProjector amplification green gate", () => {
  it.effect("preserves the 21.0x characterization workload at 2.0x after cutover", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)

      const run = (label: "small" | "large", seedSize: number) =>
        Effect.gen(function* () {
          const sessionID = Session.ID.make(`ses_amplification_${label}`)
          const assistantMessageID = SessionMessage.ID.make(`msg_amplification_${label}`)
          const durable = new Array<{
            id: Event.ID
            created: number
            aggregateID: string
            seq: number
            type: string
            data: Record<string, unknown>
          }>()
          const publish = <D extends Event.Definition>(definition: D, data: Event.Data<D>) =>
            bus.publish(definition, data).pipe(
              Effect.tap((event) =>
                Effect.sync(() => {
                  if (!event.durable) return
                  durable.push({
                    id: event.id,
                    created: event.created,
                    aggregateID: event.durable.aggregateID,
                    seq: event.durable.seq,
                    type: Bus.versionedType(event.type, event.durable.version),
                    data: Schema.decodeUnknownSync(EventData)(event.data),
                  })
                }),
              ),
            )
          const read = Effect.gen(function* () {
            const row = yield* db
              .select()
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.id, assistantMessageID))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* Effect.die("Missing synthetic assistant projection")
            return Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
          })
          const rowBytes = db
            .get(
              sql`
              SELECT length(CAST(data AS BLOB)) AS bytes
              FROM session_message
              WHERE id = ${assistantMessageID}
            `,
            )
            .pipe(
              Effect.orDie,
              Effect.map(Schema.decodeUnknownSync(RowBytes)),
              Effect.map((row) => row.bytes),
            )

          yield* db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: Project.ID.global,
              slug: `amplification-${label}`,
              directory: "/project",
              title: `amplification ${label}`,
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          yield* publish(SessionEvent.Step.Started, {
            sessionID,
            assistantMessageID,
            agent: Agent.ID.make("build"),
            model,
          })
          yield* db.run(sql`
            CREATE TEMP TABLE session_message_update_audit (
              table_name TEXT NOT NULL,
              operation TEXT NOT NULL,
              row_bytes INTEGER NOT NULL
            )
          `)
          for (const table of ["session_message", "session_assistant_active", "session_assistant_part"] as const) {
            yield* db.run(
              sql.raw(`
                CREATE TEMP TRIGGER session_message_update_audit_${table}_insert
                AFTER INSERT ON ${table}
                BEGIN
                  INSERT INTO session_message_update_audit(table_name, operation, row_bytes)
                  VALUES ('${table}', 'insert', length(CAST(NEW.data AS BLOB)));
                END
              `),
            )
            yield* db.run(
              sql.raw(`
                CREATE TEMP TRIGGER session_message_update_audit_${table}_update
                AFTER UPDATE OF data ON ${table}
                BEGIN
                  INSERT INTO session_message_update_audit(table_name, operation, row_bytes)
                  VALUES ('${table}', 'update', length(CAST(NEW.data AS BLOB)));
                END
              `),
            )
          }

          const seed = `seed:${label}:` + "s".repeat(seedSize)
          yield* publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
          yield* publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: seed })
          const seedRowBytes = yield* rowBytes

          for (const index of Array.from({ length: toolCycles }, (_, index) => index)) {
            const id = `${label}-tool-${index}`
            const name = index % 2 === 0 ? "read" : "bash"
            const input = { command: `command-${index}`, seed: `input-${index}` }
            yield* publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, id, name })
            yield* bus.publish(SessionEvent.Tool.Input.Delta, {
              sessionID,
              assistantMessageID,
              id,
              delta: "ephemeral-input-must-not-persist",
            })
            yield* publish(SessionEvent.Tool.Input.Ended, {
              sessionID,
              assistantMessageID,
              id,
              text: JSON.stringify(input),
            })
            yield* publish(SessionEvent.Tool.Called, {
              sessionID,
              assistantMessageID,
              id,
              input,
              executed: index % 2 === 0,
            })
            yield* bus.publish(SessionEvent.Tool.Progress, {
              sessionID,
              assistantMessageID,
              id,
              metadata: { forbidden: "ephemeral-progress-must-not-persist" },
            })
            if (index % 2 === 0) {
              yield* publish(SessionEvent.Tool.Success, {
                sessionID,
                assistantMessageID,
                id,
                content: [{ type: "text", text: `success-${index}` }],
                metadata: { terminal: `success-${index}` },
                executed: true,
              })
              continue
            }
            yield* publish(SessionEvent.Tool.Failed, {
              sessionID,
              assistantMessageID,
              id,
              error: { type: "unknown", message: `failure-${index}` },
              content: [{ type: "text", text: `partial-${index}` }],
              metadata: { terminal: `failure-${index}` },
              executed: false,
            })
          }

          for (const index of Array.from({ length: textPairs }, (_, index) => index)) {
            yield* publish(SessionEvent.Text.Started, {
              sessionID,
              assistantMessageID,
              ordinal: index + 1,
            })
            yield* bus.publish(SessionEvent.Text.Delta, {
              sessionID,
              assistantMessageID,
              ordinal: index + 1,
              delta: "ephemeral-text-must-not-persist",
            })
            yield* publish(SessionEvent.Text.Ended, {
              sessionID,
              assistantMessageID,
              ordinal: index + 1,
              text: `final-text-${index}`,
            })
          }
          const beforeTerminal = yield* db
            .get<{ count: number }>(
              sql`
              SELECT count(*) AS count
              FROM temp.session_message_update_audit
              WHERE table_name = 'session_message' AND operation = 'update'
            `,
            )
            .pipe(Effect.orDie)
          expect(beforeTerminal?.count).toBe(0)
          yield* publish(SessionEvent.Step.Ended, {
            sessionID,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.make(0),
            tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          const final = yield* read
          const finalRowBytes = yield* rowBytes
          const audit = yield* db
            .get(
              sql`
              SELECT
                sum(CASE WHEN table_name = 'session_message' AND operation = 'update' THEN 1 ELSE 0 END) AS updateCount,
                coalesce(sum(row_bytes), 0) AS cumulativeBytes
              FROM temp.session_message_update_audit
            `,
            )
            .pipe(Effect.orDie, Effect.map(Schema.decodeUnknownSync(Audit)))
          expect(audit.updateCount).toBe(1)
          expect(final.content.map((part) => part.type)).toEqual([
            "text",
            "tool",
            "tool",
            "tool",
            "tool",
            "text",
            "text",
          ])
          expect(final.content[0]).toMatchObject({ type: "text", text: seed })
          for (const index of Array.from({ length: toolCycles }, (_, index) => index)) {
            const part = final.content[index + 1]
            expect(part).toMatchObject({
              type: "tool",
              id: `${label}-tool-${index}`,
              name: index % 2 === 0 ? "read" : "bash",
              state:
                index % 2 === 0
                  ? {
                      status: "completed",
                      input: { command: `command-${index}`, seed: `input-${index}` },
                      content: [{ type: "text", text: `success-${index}` }],
                      metadata: { terminal: `success-${index}` },
                    }
                  : {
                      status: "error",
                      input: { command: `command-${index}`, seed: `input-${index}` },
                      error: { type: "unknown", message: `failure-${index}` },
                      content: [{ type: "text", text: `partial-${index}` }],
                      metadata: { terminal: `failure-${index}` },
                    },
            })
          }
          expect(final.content.slice(-textPairs)).toMatchObject([
            { type: "text", text: "final-text-0" },
            { type: "text", text: "final-text-1" },
          ])
          expect(JSON.stringify(final)).not.toContain("ephemeral-")
          expect(final).toMatchObject({ finish: "stop", tokens: { input: 1, output: 2 } })
          expect(
            yield* db.$count(SessionAssistantActiveTable, eq(SessionAssistantActiveTable.session_id, sessionID)),
          ).toBe(0)
          expect(
            yield* db.$count(SessionAssistantPartTable, eq(SessionAssistantPartTable.message_id, assistantMessageID)),
          ).toBe(0)
          expect(yield* db.$count(EventTable, eq(EventTable.aggregate_id, sessionID))).toBe(durable.length)

          for (const table of ["session_message", "session_assistant_active", "session_assistant_part"] as const) {
            yield* db.run(sql.raw(`DROP TRIGGER temp.session_message_update_audit_${table}_insert`))
            yield* db.run(sql.raw(`DROP TRIGGER temp.session_message_update_audit_${table}_update`))
          }
          yield* db.run(sql`DROP TABLE temp.session_message_update_audit`)
          yield* db
            .delete(SessionMessageTable)
            .where(eq(SessionMessageTable.id, assistantMessageID))
            .run()
            .pipe(Effect.orDie)
          yield* bus.remove(sessionID)
          yield* Effect.forEach(durable, (event) => bus.replay(event), { discard: true })
          expect(yield* read).toEqual(final)

          return {
            label,
            seedSize,
            seedRowBytes,
            finalRowBytes,
            updateCount: audit.updateCount,
            cumulativeBytes: audit.cumulativeBytes,
          }
        })

      const small = yield* run("small", 4 * 1024)
      const large = yield* run("large", 220 * 1024)
      const finalRowDelta = large.finalRowBytes - small.finalRowBytes
      const cumulativeDelta = large.cumulativeBytes - small.cumulativeBytes
      const deltaAmplification = cumulativeDelta / finalRowDelta

      expect(small.updateCount).toBe(1)
      expect(large.updateCount).toBe(1)
      expect(finalRowDelta).toBeGreaterThan(200 * 1024)
      expect(deltaAmplification).toBe(2)
      console.info(
        "S4 structural green gate",
        JSON.stringify({
          recordedLegacy: {
            deltaAmplification: legacyDeltaAmplification,
            smallCumulativeBytes: legacySmallCumulativeBytes,
            largeCumulativeBytes: legacyLargeCumulativeBytes,
          },
          durableMutationCount,
          ephemeralCount,
          small,
          large,
          finalRowDelta,
          cumulativeDelta,
          deltaAmplification,
          smallWriteAmplification: small.cumulativeBytes / small.finalRowBytes,
          largeWriteAmplification: large.cumulativeBytes / large.finalRowBytes,
        }),
      )
    }),
  )
})
