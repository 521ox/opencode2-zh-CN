import { and, asc, desc, eq, gt, gte, lt, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { Instructions } from "../instructions/index.js"
import { InstructionState } from "./instruction-state.js"
import { attachRemoteCompactionToolResults } from "./remote-compaction-replay.js"
import { SessionMessageProjection } from "./message-projection.js"
import { SessionMessageTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Info)

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "compaction"),
        sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  // The JSON predicate narrows SQL candidates only; the owner schema authorizes the boundary.
  const message = yield* decodeMessageRow(row)
  return message.type === "compaction" && message.status === "completed" ? { seq: row.seq } : undefined
})

export const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

export const hydrateMessageRows = (db: DatabaseService, rows: readonly (typeof SessionMessageTable.$inferSelect)[]) =>
  SessionMessageProjection.hydrate(db, rows).pipe(
    Effect.catchDefect((defect) =>
      Effect.forEach(rows, decodeMessageRow).pipe(Effect.flatMap(() => Effect.die(defect))),
    ),
  )

export type PendingToolCall = {
  readonly assistantMessageID: SessionMessage.ID
  readonly tool: SessionMessage.AssistantTool
}

/** Reads only unresolved tool calls from the active durable history suffix. */
export const pendingToolCalls = Effect.fn("SessionHistory.pendingToolCalls")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const compaction = yield* latestCompaction(db, sessionID)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const messages = yield* hydrateMessageRows(db, rows)
  return messages.flatMap((message) => {
    if (message.type !== "assistant") return []
    return message.content.flatMap((tool) =>
      tool.type === "tool" && (tool.state.status === "streaming" || tool.state.status === "running")
        ? [{ assistantMessageID: message.id, tool }]
        : [],
    )
  })
})

const previousAssistant = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID, seq: number) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        lt(SessionMessageTable.seq, seq),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const [message] = yield* hydrateMessageRows(db, [row])
  return message.type === "assistant" ? message : undefined
})

const messageEntries = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const compaction = yield* latestCompaction(db, sessionID)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const messages = yield* hydrateMessageRows(db, rows)
  const entries = messages.map((message, index) => ({ seq: rows[index].seq, message }))
  const first = entries[0]
  if (!first || first.message.type !== "compaction" || first.message.status !== "completed" || !first.message.remote)
    return entries
  const assistant = yield* previousAssistant(db, sessionID, first.seq)
  const attached = attachRemoteCompactionToolResults(
    entries.map((entry) => entry.message),
    assistant,
  )
  if (attached.length === entries.length) return entries
  return [first, { seq: first.seq, message: attached[1]! }, ...entries.slice(1)]
})

/**
 * Checks only the new remote-compaction boundary facts around a settled Step.
 * The runner owns the Step's validated tokens and same-step checkpoint fact.
 */
export const remoteCompactionForStep = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  assistantMessageID: SessionMessage.ID,
  existingRemoteCompactions: ReadonlySet<SessionMessage.ID> = new Set(),
) {
  const assistantRow = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, assistantMessageID)))
    .get()
    .pipe(Effect.orDie)
  if (!assistantRow) return undefined
  if (assistantRow.type !== "assistant") return undefined
  const isRemoteCheckpoint = (message: SessionMessage.Info) =>
    message.type === "compaction" &&
    message.status === "completed" &&
    (message.remote?.length ?? 0) > 0 &&
    !existingRemoteCompactions.has(message.id)
  const previous = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), lt(SessionMessageTable.seq, assistantRow.seq)))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (previous && isRemoteCheckpoint(yield* decodeMessageRow(previous))) return true
  const later = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "compaction"),
        gt(SessionMessageTable.seq, assistantRow.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return yield* Effect.reduce(
    later,
    () => false,
    (checkpointed, row) =>
      checkpointed ? Effect.succeed(true) : decodeMessageRow(row).pipe(Effect.map(isRemoteCheckpoint)),
  )
})

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (yield* messageEntries(db, sessionID)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
) {
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* messageEntries(db, sessionID)
        return {
          initial: yield* InstructionState.initial(db, sessionID, instructions),
          entries: messages,
        }
      }),
    )
    .pipe(Effect.orDie)
})

export const preview = Effect.fn("SessionHistory.preview")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
) {
  const observed = yield* Instructions.read(instructions)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* messageEntries(db, sessionID)
        // An active assistant may contain an unresolved tool call, so only preview the settled prefix.
        const unsettled = messages.findIndex(
          (entry) => entry.message.type === "assistant" && entry.message.time.completed === undefined,
        )
        const settled = unsettled === -1 ? messages : messages.slice(0, unsettled)
        const assembled = yield* InstructionState.preview(db, sessionID, instructions, observed)
        return {
          initial: assembled.initial,
          messages: settled.map((entry) => entry.message),
          instructionUpdate: assembled.update,
        }
      }),
    )
    .pipe(Effect.catch((error) => (error instanceof Instructions.InitializationBlocked ? error : Effect.die(error))))
})

/** Returns the session's first user message. */
export const firstUserMessage = Effect.fn("SessionHistory.firstUserMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(asc(SessionMessageTable.seq))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const message = yield* decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined))
  return message?.type === "user" ? message : undefined
})

export * as SessionHistory from "./history.js"
