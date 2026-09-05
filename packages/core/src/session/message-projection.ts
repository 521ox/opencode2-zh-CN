import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { EffectDrizzleSqlite } from "../database/drizzle.js"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"
import { SessionMessageUpdater } from "./message-updater.js"
import { SessionAssistantActiveTable, SessionAssistantPartTable, SessionMessageTable } from "./sql.js"

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Head = typeof SessionAssistantActiveTable.$inferInsert.data
export type Part = Pick<
  typeof SessionAssistantPartTable.$inferInsert,
  "position" | "type" | "type_ordinal" | "tool_id" | "data"
>

const encodeAssistant = Schema.encodeSync(SessionMessage.Assistant)
const decodeAssistant = Schema.decodeUnknownSync(SessionMessage.Assistant)
const encodeContent = Schema.encodeSync(SessionMessage.AssistantContent)
const decodeContent = Schema.decodeUnknownSync(SessionMessage.AssistantContent)

const supported = new Set<SessionEvent.DurableEvent["type"]>([
  SessionEvent.Step.Started.type,
  SessionEvent.Step.Streamed.type,
  SessionEvent.Text.Started.type,
  SessionEvent.Text.Ended.type,
  SessionEvent.Tool.Input.Started.type,
  SessionEvent.Tool.Input.Ended.type,
  SessionEvent.Tool.Called.type,
  SessionEvent.Tool.Success.type,
  SessionEvent.Tool.Failed.type,
  SessionEvent.Reasoning.Started.type,
  SessionEvent.Reasoning.Ended.type,
  SessionEvent.RetryScheduled.type,
  SessionEvent.Execution.Succeeded.type,
  SessionEvent.Execution.Failed.type,
  SessionEvent.Execution.Interrupted.type,
])

const routed = new Set<SessionEvent.DurableEvent["type"]>([
  ...supported,
  SessionEvent.Step.Ended.type,
  SessionEvent.Step.Failed.type,
])

export function handles(event: SessionEvent.DurableEvent) {
  return routed.has(event.type)
}

export function requireSettled(
  db: DatabaseClient,
  sessionID: SessionEvent.DurableEvent["data"]["sessionID"],
  messageID: SessionMessage.ID,
) {
  return db
    .select({ sessionID: SessionAssistantActiveTable.session_id })
    .from(SessionAssistantActiveTable)
    .where(eq(SessionAssistantActiveTable.message_id, messageID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.tap((row) => {
        if (!row) return Effect.void
        if (row.sessionID !== sessionID)
          return Effect.die(new Error(`Active assistant ${messageID} belongs to a different session`))
        return Effect.die(new Error(`Message update requires settled assistant ${messageID}`))
      }),
      Effect.asVoid,
    )
}

export function encode(assistant: SessionMessage.Assistant): { readonly head: Head; readonly parts: readonly Part[] } {
  const { id: _, type: __, content: ___, ...head } = encodeAssistant(assistant)
  const ordinals = { text: 0, reasoning: 0, tool: 0 }
  const parts = assistant.content.map((item, position) => {
    const data = encodeContent(item)
    return {
      position,
      type: data.type,
      type_ordinal: ordinals[data.type]++,
      tool_id: data.type === "tool" ? data.id : null,
      data,
    }
  })
  return { head, parts }
}

export function assemble(messageID: SessionMessage.ID, head: Head, rows: readonly Part[]) {
  const ordinals = { text: 0, reasoning: 0, tool: 0 }
  const content = rows.map((row, position) => {
    if (!Number.isInteger(row.position) || row.position !== position)
      throw new Error(`Invalid active assistant part position ${row.position}`)
    if (!Number.isInteger(row.type_ordinal) || row.type_ordinal !== ordinals[row.type]++)
      throw new Error(`Invalid active assistant ${row.type} ordinal ${row.type_ordinal}`)
    const part = decodeContent(row.data)
    if (part.type !== row.type) throw new Error(`Active assistant part type mismatch at ${position}`)
    if (part.type === "tool" && row.tool_id !== part.id)
      throw new Error(`Active assistant tool identity mismatch at ${position}`)
    if (part.type !== "tool" && row.tool_id !== null)
      throw new Error(`Unexpected active assistant tool identity at ${position}`)
    return row.data
  })
  const assistant = decodeAssistant({ ...head, id: messageID, type: "assistant", content })
  if (assistant.time.completed) throw new Error(`Completed assistant ${messageID} cannot remain active`)
  return assistant
}

export type SidecarIntegrityResult = {
  readonly applicable: boolean
  readonly heads: number
  readonly parts: number
  readonly violations: readonly string[]
}

export function checkActiveIntegrity(db: DatabaseClient): Effect.Effect<SidecarIntegrityResult, never, never> {
  return Effect.gen(function* () {
    const migrated = yield* db
      .get<{ id: string }>(sql`SELECT id FROM migration WHERE id = ${"20260829110336_session_assistant_sidecar"}`)
      .pipe(Effect.orDie)
    if (!migrated) return { applicable: false, heads: 0, parts: 0, violations: [] }

    const heads = yield* db.select().from(SessionAssistantActiveTable).all().pipe(Effect.orDie)
    const parts = yield* db.$count(SessionAssistantPartTable).pipe(Effect.orDie)
    const violations: string[] = []
    const orphanParts = yield* db
      .all<{ messageID: string }>(
        sql`
        SELECT part.message_id AS messageID
        FROM session_assistant_part AS part
        LEFT JOIN session_assistant_active AS active ON active.message_id = part.message_id
        WHERE active.message_id IS NULL
        ORDER BY part.message_id, part.position
      `,
      )
      .pipe(Effect.orDie)
    for (const part of orphanParts) violations.push(`orphan part ${part.messageID}`)

    const multipleHeads = yield* db
      .all<{ sessionID: string; count: number }>(
        sql`
        SELECT session_id AS sessionID, count(*) AS count
        FROM session_assistant_active
        GROUP BY session_id
        HAVING count(*) > 1
        ORDER BY session_id
      `,
      )
      .pipe(Effect.orDie)
    for (const row of multipleHeads) violations.push(`multiple heads for Session ${row.sessionID}`)

    for (const head of heads) {
      const anchor = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, head.message_id))
        .get()
        .pipe(Effect.orDie)
      if (!anchor) {
        violations.push(`head ${head.message_id} without anchor`)
        continue
      }
      if (anchor.session_id !== head.session_id)
        violations.push(`head ${head.message_id} Session mismatch (${head.session_id} != ${anchor.session_id})`)
      if (anchor.type !== "assistant") violations.push(`anchor ${head.message_id} type is not assistant`)
      const invalid = invalidAnchor(anchor)
      if (invalid) violations.push(invalid)
    }
    return { applicable: true, heads: heads.length, parts, violations }
  })
}

export type DrainResult = { readonly drained: number; readonly heads: number; readonly parts: number }

export function drainActive(db: DatabaseClient): Effect.Effect<DrainResult, never, never> {
  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const integrity = yield* checkActiveIntegrity(tx)
          if (integrity.violations.length > 0)
            return yield* Effect.die(
              new Error(`Cannot drain active assistant sidecars: ${integrity.violations.join("; ")}`),
            )
          if (integrity.heads === 0) return { drained: 0, heads: 0, parts: 0 }

          const heads = yield* tx.select().from(SessionAssistantActiveTable).all().pipe(Effect.orDie)
          for (const head of heads) {
            const anchor = yield* tx
              .select()
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.id, head.message_id))
              .get()
              .pipe(Effect.orDie)
            if (!anchor) return yield* Effect.die(new Error(`Cannot drain missing anchor ${head.message_id}`))
            const parts = yield* tx
              .select()
              .from(SessionAssistantPartTable)
              .where(eq(SessionAssistantPartTable.message_id, head.message_id))
              .orderBy(asc(SessionAssistantPartTable.position))
              .all()
              .pipe(Effect.orDie)
            const assistant = assemble(head.message_id, head.data, parts)
            const encoded = encodeAssistant(assistant)
            const { id, type, ...data } = encoded
            const updated = yield* tx
              .update(SessionMessageTable)
              .set({ type, time_created: DateTime.toEpochMillis(assistant.time.created), data })
              .where(eq(SessionMessageTable.id, SessionMessage.ID.make(id)))
              .returning({ id: SessionMessageTable.id })
              .get()
              .pipe(Effect.orDie)
            if (!updated) return yield* Effect.die(new Error(`Cannot drain missing anchor ${head.message_id}`))
          }

          yield* tx.delete(SessionAssistantActiveTable).run().pipe(Effect.orDie)
          const remainingHeads = yield* tx.$count(SessionAssistantActiveTable).pipe(Effect.orDie)
          const remainingParts = yield* tx.$count(SessionAssistantPartTable).pipe(Effect.orDie)
          if (remainingHeads !== 0 || remainingParts !== 0)
            return yield* Effect.die(
              new Error(`Active assistant drain left ${remainingHeads} heads and ${remainingParts} parts`),
            )
          return { drained: heads.length, heads: remainingHeads, parts: remainingParts }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
}

export function hydrate(db: DatabaseClient, rows: readonly (typeof SessionMessageTable.$inferSelect)[]) {
  return Effect.gen(function* () {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const heads = yield* db
      .select()
      .from(SessionAssistantActiveTable)
      .where(inArray(SessionAssistantActiveTable.message_id, ids))
      .all()
      .pipe(Effect.orDie)
    const sessions = new Set<SessionEvent.DurableEvent["data"]["sessionID"]>()
    const headsByID = new Map(heads.map((head) => [head.message_id, head]))
    for (const head of heads) {
      if (sessions.has(head.session_id)) throw new Error(`Session ${head.session_id} has multiple active assistants`)
      sessions.add(head.session_id)
    }
    const parts =
      heads.length > 0
        ? yield* db
            .select()
            .from(SessionAssistantPartTable)
            .where(
              inArray(
                SessionAssistantPartTable.message_id,
                heads.map((head) => head.message_id),
              ),
            )
            .orderBy(asc(SessionAssistantPartTable.message_id), asc(SessionAssistantPartTable.position))
            .all()
            .pipe(Effect.orDie)
        : []
    const partsByID = new Map<SessionMessage.ID, Part[]>()
    for (const part of parts) {
      if (!headsByID.has(part.message_id)) throw new Error(`Active assistant part ${part.message_id} has no head`)
      const grouped = partsByID.get(part.message_id)
      if (grouped) grouped.push(part)
      else partsByID.set(part.message_id, [part])
    }
    return rows.map((row) => {
      const head = headsByID.get(row.id)
      if (!head) return decodeMessageRow(row)
      if (row.session_id !== head.session_id)
        throw new Error(`Active assistant ${row.id} belongs to a different session`)
      requireAnchor(row)
      return assemble(row.id, head.data, partsByID.get(row.id) ?? [])
    })
  })
}

export function project(db: DatabaseClient, event: SessionEvent.DurableEvent) {
  return Effect.gen(function* () {
    if (!supported.has(event.type)) throw new Error(`Unsupported active assistant event ${event.type}`)
    const sessionID = event.data.sessionID
    if (event.type === SessionEvent.Step.Started.type) {
      const currentID = yield* readCurrentID(db, sessionID)
      if (currentID && currentID !== event.data.assistantMessageID)
        throw new Error(`New assistant ${event.data.assistantMessageID} requires supersession fold`)
    }

    const adapter: SessionMessageUpdater.Adapter = {
      getAgent: () => Effect.succeed(undefined),
      getModel: () => Effect.succeed(undefined),
      getLocation: () => Effect.succeed(undefined),
      getCurrentAssistant: () => readCurrent(db, sessionID),
      getAssistant: (messageID) => readActive(db, sessionID, messageID),
      getShell: () => Effect.succeed(undefined),
      getCompaction: () => Effect.succeed(undefined),
      updateAssistant: (assistant) => updateActive(db, sessionID, assistant),
      updateShell: () => Effect.die(new Error("Active assistant projection cannot update a shell")),
      updateCompaction: () => Effect.die(new Error("Active assistant projection cannot update a compaction")),
      appendMessage: (message) => {
        if (message.type !== "assistant")
          return Effect.die(new Error(`Active assistant projection cannot append ${message.type}`))
        return insertActive(db, sessionID, event.durable.seq, message)
      },
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

/** Called only by SessionProjector while Bus owns the durable IMMEDIATE transaction. */
export function projectInTransaction(
  db: DatabaseClient,
  event: SessionEvent.DurableEvent,
  legacy: SessionMessageUpdater.Adapter,
) {
  return Effect.gen(function* () {
    if (!handles(event)) throw new Error(`Unsupported production active assistant event ${event.type}`)
    if (event.type === SessionEvent.Step.Started.type) {
      yield* projectStarted(db, event, legacy)
      return
    }
    if (
      event.type === SessionEvent.Execution.Succeeded.type ||
      event.type === SessionEvent.Execution.Failed.type ||
      event.type === SessionEvent.Execution.Interrupted.type
    ) {
      const current = yield* readCurrent(db, event.data.sessionID)
      if (!current) {
        yield* SessionMessageUpdater.update(legacy, event)
        return
      }
      yield* requireNoLegacyCurrent(db, event.data.sessionID, current.id)
      yield* project(db, event)
      return
    }
    if (!("assistantMessageID" in event.data))
      throw new Error(`Active assistant event ${event.type} has no assistant identity`)

    const active = yield* readHead(db, event.data.sessionID, event.data.assistantMessageID)
    if (!active) {
      yield* SessionMessageUpdater.update(legacy, event)
      return
    }
    const currentID = yield* readCurrentID(db, event.data.sessionID)
    if (currentID !== active.message_id)
      throw new Error(`Assistant ${active.message_id} is not the current active assistant`)
    yield* requireNoLegacyCurrent(db, event.data.sessionID, active.message_id)
    if (event.type !== SessionEvent.Step.Ended.type && event.type !== SessionEvent.Step.Failed.type) {
      yield* project(db, event)
      return
    }
    yield* SessionMessageUpdater.update(
      activeAdapter(db, event.data.sessionID, {
        updateAssistant: (assistant) => materialize(db, event.data.sessionID, assistant),
      }),
      event,
    )
  })
}

function projectStarted(
  db: DatabaseClient,
  event: typeof SessionEvent.Step.Started.Type,
  legacy: SessionMessageUpdater.Adapter,
) {
  return Effect.gen(function* () {
    const currentID = yield* readCurrentID(db, event.data.sessionID)
    const active = yield* readHead(db, event.data.sessionID, event.data.assistantMessageID)
    if (active) {
      if (currentID !== active.message_id)
        throw new Error(`Assistant ${active.message_id} is not the current active assistant`)
      yield* requireNoLegacyCurrent(db, event.data.sessionID, active.message_id)
      yield* SessionMessageUpdater.update(activeAdapter(db, event.data.sessionID), event)
      return
    }

    const existing = yield* legacy.getAssistant(event.data.assistantMessageID)
    if (existing && !existing.time.completed) {
      if (currentID) throw new Error(`Session ${event.data.sessionID} has simultaneous active assistant owners`)
      yield* SessionMessageUpdater.update(legacy, event)
      return
    }
    if (existing) {
      if (currentID) throw new Error(`Cannot reopen ${existing.id} while ${currentID} is active`)
      const legacyCurrent = yield* legacy.getCurrentAssistant()
      if (legacyCurrent && legacyCurrent.id !== existing.id)
        throw new Error(`Cannot reopen ${existing.id} while legacy assistant ${legacyCurrent.id} is active`)
      yield* SessionMessageUpdater.update(
        activeAdapter(db, event.data.sessionID, {
          getAssistant: (messageID) => Effect.succeed(messageID === existing.id ? existing : undefined),
          updateAssistant: (assistant) => dematerialize(db, event.data.sessionID, assistant),
        }),
        event,
      )
      return
    }

    if (currentID) yield* requireNoLegacyCurrent(db, event.data.sessionID, currentID)
    const legacyCurrent = currentID ? undefined : yield* legacy.getCurrentAssistant()
    yield* SessionMessageUpdater.update(
      activeAdapter(db, event.data.sessionID, {
        getCurrentAssistant: () =>
          currentID ? readActive(db, event.data.sessionID, currentID) : Effect.succeed(legacyCurrent),
        updateAssistant: (assistant) =>
          currentID ? materialize(db, event.data.sessionID, assistant) : legacy.updateAssistant(assistant),
        appendMessage: (message) => appendActive(db, event, message),
      }),
      event,
    )
  })
}

function activeAdapter(
  db: DatabaseClient,
  sessionID: SessionEvent.DurableEvent["data"]["sessionID"],
  overrides: Partial<SessionMessageUpdater.Adapter> = {},
): SessionMessageUpdater.Adapter {
  return {
    getAgent: () => Effect.succeed(undefined),
    getModel: () => Effect.succeed(undefined),
    getLocation: () => Effect.succeed(undefined),
    getCurrentAssistant: () => readCurrent(db, sessionID),
    getAssistant: (messageID) => readActive(db, sessionID, messageID),
    getShell: () => Effect.succeed(undefined),
    getCompaction: () => Effect.succeed(undefined),
    updateAssistant: (assistant) => updateActive(db, sessionID, assistant),
    updateShell: () => Effect.die(new Error("Active assistant projection cannot update a shell")),
    updateCompaction: () => Effect.die(new Error("Active assistant projection cannot update a compaction")),
    appendMessage: () => Effect.die(new Error("Active assistant projection cannot append a message")),
    ...overrides,
  }
}

function readCurrent(db: DatabaseClient, sessionID: SessionEvent.DurableEvent["data"]["sessionID"]) {
  return Effect.gen(function* () {
    const messageID = yield* readCurrentID(db, sessionID)
    if (!messageID) return undefined
    return yield* readActive(db, sessionID, messageID)
  })
}

function readCurrentID(db: DatabaseClient, sessionID: SessionEvent.DurableEvent["data"]["sessionID"]) {
  return Effect.gen(function* () {
    const heads = yield* db
      .select({ messageID: SessionAssistantActiveTable.message_id })
      .from(SessionAssistantActiveTable)
      .where(eq(SessionAssistantActiveTable.session_id, sessionID))
      .limit(2)
      .all()
      .pipe(Effect.orDie)
    if (heads.length > 1) throw new Error(`Session ${sessionID} has multiple active assistants`)
    if (!heads[0]) return undefined
    return heads[0].messageID
  })
}

function readActive(
  db: DatabaseClient,
  sessionID: SessionEvent.DurableEvent["data"]["sessionID"],
  messageID: SessionMessage.ID,
) {
  return Effect.gen(function* () {
    const head = yield* readHead(db, sessionID, messageID)
    if (!head) return undefined
    const anchor = yield* db
      .select()
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.id, messageID),
          eq(SessionMessageTable.session_id, sessionID),
          eq(SessionMessageTable.type, "assistant"),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!anchor) throw new Error(`Active assistant ${messageID} has no message anchor`)
    requireAnchor(anchor)
    const rows = yield* db
      .select()
      .from(SessionAssistantPartTable)
      .where(eq(SessionAssistantPartTable.message_id, messageID))
      .orderBy(asc(SessionAssistantPartTable.position))
      .all()
      .pipe(Effect.orDie)
    return assemble(messageID, head.data, rows)
  })
}

function readHead(
  db: DatabaseClient,
  sessionID: SessionEvent.DurableEvent["data"]["sessionID"],
  messageID: SessionMessage.ID,
) {
  return db
    .select()
    .from(SessionAssistantActiveTable)
    .where(eq(SessionAssistantActiveTable.message_id, messageID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.tap((head) => {
        if (!head || head.session_id === sessionID) return Effect.void
        return Effect.die(new Error(`Active assistant ${messageID} belongs to a different session`))
      }),
    )
}

function requireAnchor(row: typeof SessionMessageTable.$inferSelect) {
  const anchored = decodeMessageRow(row)
  if (anchored.type !== "assistant" || anchored.content.length !== 0 || anchored.time.completed)
    throw new Error(`Active assistant ${row.id} has an invalid message anchor`)
  return anchored
}

function invalidAnchor(row: typeof SessionMessageTable.$inferSelect) {
  try {
    requireAnchor(row)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : `Active assistant ${row.id} has an invalid message anchor`
  }
}

function decodeMessageRow(row: typeof SessionMessageTable.$inferSelect) {
  return Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type })
}

function requireNoLegacyCurrent(
  db: DatabaseClient,
  sessionID: SessionEvent.DurableEvent["data"]["sessionID"],
  activeID: SessionMessage.ID,
) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(2)
      .all()
      .pipe(Effect.orDie)
    const row = rows.find((item) => item.id !== activeID)
    if (!row) return
    const assistant = decodeMessageRow(row)
    if (assistant.type === "assistant" && !assistant.time.completed)
      throw new Error(`Session ${sessionID} has simultaneous active assistant owners`)
  })
}

function insertActive(
  db: DatabaseClient,
  sessionID: SessionEvent.DurableEvent["data"]["sessionID"],
  seq: number,
  assistant: SessionMessage.Assistant,
) {
  return Effect.gen(function* () {
    if (assistant.time.completed || assistant.content.length !== 0)
      throw new Error(`New active assistant ${assistant.id} must be incomplete and content-free`)
    if (yield* readCurrent(db, sessionID)) throw new Error(`Session ${sessionID} already has an active assistant`)
    const encoded = encodeAssistant(assistant)
    const { id, type, ...data } = encoded
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: SessionMessage.ID.make(id),
        session_id: sessionID,
        type,
        seq,
        time_created: DateTime.toEpochMillis(assistant.time.created),
        data,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionAssistantActiveTable)
      .values({ message_id: assistant.id, session_id: sessionID, data: encode(assistant).head })
      .run()
      .pipe(Effect.orDie)
  })
}

function appendActive(db: DatabaseClient, event: typeof SessionEvent.Step.Started.Type, message: SessionMessage.Info) {
  if (message.type !== "assistant")
    return Effect.die(new Error(`Active assistant projection cannot append ${message.type}`))
  return insertActive(db, event.data.sessionID, event.durable.seq, message)
}

function materialize(
  db: DatabaseClient,
  sessionID: SessionEvent.DurableEvent["data"]["sessionID"],
  assistant: SessionMessage.Assistant,
) {
  return Effect.gen(function* () {
    if (!assistant.time.completed) throw new Error(`Assistant ${assistant.id} cannot fold without completion`)
    const encoded = encodeAssistant(assistant)
    const { id, type, ...data } = encoded
    const updated = yield* db
      .update(SessionMessageTable)
      .set({ type, time_created: DateTime.toEpochMillis(assistant.time.created), data })
      .where(
        and(
          eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
          eq(SessionMessageTable.session_id, sessionID),
          eq(SessionMessageTable.type, "assistant"),
        ),
      )
      .returning({ id: SessionMessageTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!updated) throw new Error(`Cannot fold missing active assistant ${assistant.id}`)
    const deleted = yield* db
      .delete(SessionAssistantActiveTable)
      .where(
        and(
          eq(SessionAssistantActiveTable.message_id, assistant.id),
          eq(SessionAssistantActiveTable.session_id, sessionID),
        ),
      )
      .returning({ id: SessionAssistantActiveTable.message_id })
      .get()
      .pipe(Effect.orDie)
    if (!deleted) throw new Error(`Cannot delete missing active assistant ${assistant.id}`)
  })
}

function dematerialize(
  db: DatabaseClient,
  sessionID: SessionEvent.DurableEvent["data"]["sessionID"],
  assistant: SessionMessage.Assistant,
) {
  return Effect.gen(function* () {
    if (assistant.time.completed) throw new Error(`Reopened assistant ${assistant.id} remains completed`)
    const encoded = encode(assistant)
    const anchor = { id: assistant.id, type: "assistant" as const, ...encoded.head, content: [] }
    const { id, type, ...data } = anchor
    const updated = yield* db
      .update(SessionMessageTable)
      .set({ type, time_created: DateTime.toEpochMillis(assistant.time.created), data })
      .where(
        and(
          eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
          eq(SessionMessageTable.session_id, sessionID),
          eq(SessionMessageTable.type, "assistant"),
        ),
      )
      .returning({ id: SessionMessageTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!updated) throw new Error(`Cannot reopen missing assistant ${assistant.id}`)
    yield* db
      .insert(SessionAssistantActiveTable)
      .values({ message_id: assistant.id, session_id: sessionID, data: encoded.head })
      .run()
      .pipe(Effect.orDie)
    if (encoded.parts.length === 0) return
    yield* db
      .insert(SessionAssistantPartTable)
      .values(encoded.parts.map((part) => ({ message_id: assistant.id, ...part })))
      .run()
      .pipe(Effect.orDie)
  })
}

function updateActive(
  db: DatabaseClient,
  sessionID: SessionEvent.DurableEvent["data"]["sessionID"],
  assistant: SessionMessage.Assistant,
) {
  return Effect.gen(function* () {
    const before = yield* readActive(db, sessionID, assistant.id)
    if (!before) throw new Error(`Cannot update inactive assistant ${assistant.id}`)
    if (assistant.time.completed) throw new Error(`Terminal update for active assistant ${assistant.id} requires fold`)
    const previous = encode(before)
    const next = encode(assistant)
    const changed = next.parts.filter((part, index) => !isDeepStrictEqual(part, previous.parts[index]))
    const removed = previous.parts.slice(next.parts.length)
    if (removed.length || next.parts.length > previous.parts.length + 1 || changed.length > 1)
      throw new Error(`Assistant ${assistant.id} update requires multiple part mutations`)
    const part = changed[0]
    if (part && part.position < previous.parts.length) {
      const prior = previous.parts[part.position]
      if (
        !prior ||
        part.type !== prior.type ||
        part.type_ordinal !== prior.type_ordinal ||
        part.tool_id !== prior.tool_id
      )
        throw new Error(`Assistant ${assistant.id} update changes part identity`)
    }
    if (part && part.position === previous.parts.length && part.position !== next.parts.length - 1)
      throw new Error(`Assistant ${assistant.id} update inserts a non-terminal part`)

    if (!isDeepStrictEqual(previous.head, next.head))
      yield* db
        .update(SessionAssistantActiveTable)
        .set({ data: next.head })
        .where(eq(SessionAssistantActiveTable.message_id, assistant.id))
        .run()
        .pipe(Effect.orDie)
    if (!part) return
    if (part.position === previous.parts.length) {
      yield* db
        .insert(SessionAssistantPartTable)
        .values({ message_id: assistant.id, ...part })
        .run()
        .pipe(Effect.orDie)
      return
    }
    yield* db
      .update(SessionAssistantPartTable)
      .set({ data: encodeContent(assistant.content[part.position]) })
      .where(
        and(
          eq(SessionAssistantPartTable.message_id, assistant.id),
          eq(SessionAssistantPartTable.position, part.position),
        ),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

export * as SessionMessageProjection from "./message-projection.js"
