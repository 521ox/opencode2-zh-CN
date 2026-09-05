export * as SessionStore from "./store.js"

import { and, eq, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database.js"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { SessionHistory } from "./history.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { Session } from "@opencode-ai/schema/session"
import { AbsolutePath } from "../schema.js"
import { SessionMessageTable, SessionTable } from "./sql.js"
import { fromRow } from "./info.js"
import { SessionRulesLocation } from "./rules-location.js"

export type Owner = {
  readonly id: string
  readonly pid: number
  readonly hostname: string
  readonly leaseMs: number
}

export const requireOwnership = (sessionID: Session.ID, owner: Owner, operation: string) => (owned: boolean) =>
  owned
    ? Effect.void
    : Effect.die(new Error(`Session execution lease lost before ${operation}: session=${sessionID} owner=${owner.id}`))

export interface Interface {
  readonly get: (sessionID: Session.ID) => Effect.Effect<Session.Info | undefined>
  /** Reads immutable lineage facts used to derive one Session rules directory. */
  readonly rulesParent: (sessionID: Session.ID) => Effect.Effect<SessionRulesLocation.SessionParent | undefined>
  readonly context: (sessionID: Session.ID) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  readonly pendingToolCalls: (
    sessionID: Session.ID,
  ) => Effect.Effect<ReadonlyArray<SessionHistory.PendingToolCall>, MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.Info } | undefined>
  /**
   * Top-level Sessions holding an execution claim. Recoverable background
   * children are resumed separately through their durable Job records.
   */
  readonly listSuspended: () => Effect.Effect<ReadonlyArray<Session.ID>>
  /**
   * Atomically acquires or renews a process-scoped execution lease. A surviving
   * claim marks a turn that did not terminalize before its owner stopped.
   */
  readonly claim: (sessionID: Session.ID, owner: Owner) => Effect.Effect<boolean>
  readonly owns: (sessionID: Session.ID, owner: Owner) => Effect.Effect<boolean>
  readonly touch: (sessionID: Session.ID, owner: Owner) => Effect.Effect<boolean>
  /** Releases the claim and resets resume accounting. Terminal events call this on commit. */
  readonly release: (sessionID: Session.ID, owner: Owner) => Effect.Effect<boolean>
  /**
   * Clears unowned, legacy, or expired non-recoverable child claims. A fresh
   * child lease or a current recoverable Job remains untouched during cleanup.
   */
  readonly releaseChildClaims: (recoverable: ReadonlyArray<Session.ID>, owner?: Owner) => Effect.Effect<void>
  readonly expireOwner: (owner: Owner) => Effect.Effect<void>
  /**
   * Durably counts one more resume of an orphaned claim, returning the new
   * total — or undefined when the Session no longer exists.
   */
  readonly countResume: (sessionID: Session.ID, owner: Owner) => Effect.Effect<number | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Service.of({
      get: Effect.fnUntraced(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      rulesParent: Effect.fn("SessionStore.rulesParent")(function* (sessionID) {
        const row = yield* db
          .select({
            id: SessionTable.id,
            parentID: SessionTable.parent_id,
            startDirectory: SessionTable.start_directory,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        return row
          ? {
              id: Session.ID.make(row.id),
              parentID: row.parentID ? Session.ID.make(row.parentID) : undefined,
              startDirectory: row.startDirectory ? AbsolutePath.make(row.startDirectory) : undefined,
            }
          : undefined
      }),
      context: Effect.fn("SessionStore.context")((sessionID) => SessionHistory.load(db, sessionID)),
      pendingToolCalls: Effect.fn("SessionStore.pendingToolCalls")((sessionID) =>
        SessionHistory.pendingToolCalls(db, sessionID),
      ),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return undefined
        const [message] = yield* SessionHistory.hydrateMessageRows(db, [row]).pipe(Effect.orDie)
        return { sessionID: Session.ID.make(row.session_id), message }
      }),
      listSuspended: Effect.fn("SessionStore.listSuspended")(function* () {
        return yield* db
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(and(isNotNull(SessionTable.time_suspended), isNull(SessionTable.parent_id)))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => row.sessionID)),
          )
      }),
      claim: Effect.fn("SessionStore.claim")(function* (sessionID, owner) {
        const now = Date.now()
        const row = yield* db
          .update(SessionTable)
          .set({
            time_suspended: sql`coalesce(${SessionTable.time_suspended}, ${now})`,
            resume_attempts: sql`case when ${SessionTable.time_suspended} is null then 0 else ${SessionTable.resume_attempts} end`,
            claim_owner: owner.id,
            claim_pid: owner.pid,
            claim_hostname: owner.hostname,
            claim_updated_at: now,
            claim_expires_at: now + owner.leaseMs,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(
            and(
              eq(SessionTable.id, sessionID),
              or(
                isNull(SessionTable.claim_owner),
                eq(SessionTable.claim_owner, owner.id),
                lte(SessionTable.claim_expires_at, now),
              ),
            ),
          )
          .returning({ id: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        return row !== undefined
      }),
      owns: Effect.fn("SessionStore.owns")(function* (sessionID, owner) {
        const row = yield* db
          .update(SessionTable)
          .set({ time_updated: sql`${SessionTable.time_updated}` })
          .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.claim_owner, owner.id)))
          .returning({ id: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        return row !== undefined
      }),
      touch: Effect.fn("SessionStore.touch")(function* (sessionID, owner) {
        const now = Date.now()
        const row = yield* db
          .update(SessionTable)
          .set({
            claim_updated_at: now,
            claim_expires_at: now + owner.leaseMs,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.claim_owner, owner.id)))
          .returning({ id: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        return row !== undefined
      }),
      release: Effect.fn("SessionStore.release")(function* (sessionID, owner) {
        const row = yield* db
          .update(SessionTable)
          .set({
            time_suspended: null,
            resume_attempts: 0,
            claim_owner: null,
            claim_pid: null,
            claim_hostname: null,
            claim_updated_at: null,
            claim_expires_at: null,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.claim_owner, owner.id)))
          .returning({ id: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        return row !== undefined
      }),
      releaseChildClaims: Effect.fn("SessionStore.releaseChildClaims")(function* (recoverable, owner) {
        const now = Date.now()
        const ownerLegacyClaim = owner
          ? and(eq(SessionTable.claim_owner, owner.id), isNull(SessionTable.claim_expires_at))
          : undefined
        yield* db
          .update(SessionTable)
          .set({
            time_suspended: null,
            resume_attempts: 0,
            claim_owner: null,
            claim_pid: null,
            claim_hostname: null,
            claim_updated_at: null,
            claim_expires_at: null,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(
            and(
              isNotNull(SessionTable.time_suspended),
              isNotNull(SessionTable.parent_id),
              recoverable.length > 0 ? notInArray(SessionTable.id, Array.from(recoverable)) : undefined,
              or(isNull(SessionTable.claim_owner), lte(SessionTable.claim_expires_at, now), ownerLegacyClaim),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
      expireOwner: Effect.fn("SessionStore.expireOwner")(function* (owner) {
        const now = Date.now()
        yield* db
          .update(SessionTable)
          .set({
            claim_updated_at: now,
            claim_expires_at: now,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(eq(SessionTable.claim_owner, owner.id))
          .run()
          .pipe(Effect.orDie)
      }),
      countResume: Effect.fn("SessionStore.countResume")(function* (sessionID, owner) {
        const row = yield* db
          .update(SessionTable)
          .set({
            resume_attempts: sql`${SessionTable.resume_attempts} + 1`,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.claim_owner, owner.id)))
          .returning({ attempts: SessionTable.resume_attempts })
          .get()
          .pipe(Effect.orDie)
        return row?.attempts
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
