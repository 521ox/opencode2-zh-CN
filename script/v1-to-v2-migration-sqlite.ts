#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import {
  transformSession,
  type SourceMessage,
  type SourcePart,
  type TransformInput,
} from "../packages/core/src/database/v1-migration.bun.ts"

const [command, databasePath] = process.argv.slice(2)
const commands = ["inspect-source", "checkpoint-copy", "verify-migrated"] as const
type Command = (typeof commands)[number]

if (!command || !databasePath || !commands.includes(command as Command)) {
  throw new Error(`Usage: ${commands.join("|")} <database>`)
}

function values(rows: Record<string, unknown>[]) {
  return rows.flatMap((row) => Object.values(row)).map(String)
}

function open(readonly: boolean) {
  return new Database(databasePath, { readonly, strict: true })
}

function tableExists(db: Database, name: string) {
  return (
    db
      .query<{ found: number }, [string]>("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== null
  )
}

function tableCount(db: Database, name: string) {
  if (!tableExists(db, name)) return null
  return Number(db.query<{ value: number }, []>(`SELECT COUNT(*) AS value FROM \`${name}\``).get()?.value ?? 0)
}

function counts(db: Database) {
  const names = [
    "session",
    "message",
    "part",
    "event",
    "event_sequence",
    "migration",
    "session_v2",
    "session_message",
    "kv",
    "remote_compaction_item",
    "session_subagent",
  ] as const
  return Object.fromEntries(names.map((name) => [name, tableCount(db, name)]))
}

function quickCheck(db: Database) {
  return values(db.query("PRAGMA quick_check").all() as Record<string, unknown>[])
}

function inspectSource() {
  const db = open(true)
  try {
    const partSequence = tableExists(db, "part")
      ? db
          .query(
            "SELECT name, type, \"notnull\" AS required, dflt_value AS defaultValue FROM pragma_table_info('part') WHERE name = 'seq'",
          )
          .get()
      : null
    return {
      databasePath,
      bytes: statSync(databasePath).size,
      quickCheck: quickCheck(db),
      journalMode: values(db.query("PRAGMA journal_mode").all() as Record<string, unknown>[])[0],
      schemaVersion: Number(
        db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()?.schema_version ?? 0,
      ),
      counts: counts(db),
      partSequence,
      tables: db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    }
  } finally {
    db.close()
  }
}

function checkpointCopy() {
  const db = open(false)
  try {
    db.exec("PRAGMA busy_timeout=5000")
    const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").all() as Record<string, unknown>[]
    return {
      databasePath,
      checkpoint,
      quickCheck: quickCheck(db),
      journalMode: values(db.query("PRAGMA journal_mode").all() as Record<string, unknown>[])[0],
    }
  } finally {
    db.close()
  }
}

type LegacySession = {
  id: string
  agent: string | null
  model: string | null
  revert: string | null
  time_compacting: number | null
}

type V2Session = Record<string, unknown> & {
  id: string
  agent: string | null
  model: string | null
  revert: string | null
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  time_compacting: number | null
}

type V2Message = {
  id: string
  session_id: string
  type: string
  seq: number
  time_created: number
  time_updated: number
  data: string
}

function parseJson(value: string | null) {
  if (value === null) return null
  return JSON.parse(value) as unknown
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

function same(left: unknown, right: unknown) {
  return canonical(left) === canonical(right)
}

function verifyMigrated() {
  const db = open(true)
  const mismatches: Array<Record<string, unknown>> = []
  const warnings: Array<Record<string, unknown>> = []
  const missingSessions: string[] = []
  const extraSessions: string[] = []
  const sampleLimit = 50

  const mismatch = (value: Record<string, unknown>) => {
    if (mismatches.length < sampleLimit) mismatches.push(value)
  }
  const warning = (value: Record<string, unknown>) => {
    if (warnings.length < sampleLimit) warnings.push(value)
  }

  try {
    const requiredTables = ["session", "message", "part", "session_v2", "session_message", "event_sequence", "kv"]
    const absent = requiredTables.filter((name) => !tableExists(db, name))
    if (absent.length) throw new Error(`Migrated database is missing required tables: ${absent.join(", ")}`)

    const hasPartSequence =
      db
        .query<{ value: number }, []>("SELECT 1 AS value FROM pragma_table_info('part') WHERE name = 'seq' LIMIT 1")
        .get() !== null
    const legacyIDs = db
      .query<{ id: string }, []>("SELECT id FROM session ORDER BY id")
      .all()
      .map((row) => row.id)
    const legacySet = new Set(legacyIDs)
    const v2IDs = db
      .query<{ id: string }, []>("SELECT id FROM session_v2 ORDER BY id")
      .all()
      .map((row) => row.id)
    const v2Set = new Set(v2IDs)
    const missingSessionCount = legacyIDs.filter((id) => !v2Set.has(id)).length
    const extraSessionCount = v2IDs.filter((id) => !legacySet.has(id)).length
    for (const id of legacyIDs) if (!v2Set.has(id) && missingSessions.length < sampleLimit) missingSessions.push(id)
    for (const id of v2IDs) if (!legacySet.has(id) && extraSessions.length < sampleLimit) extraSessions.push(id)

    let warningCount = 0
    let mismatchCount = missingSessionCount + extraSessionCount
    let comparedSessions = 0
    for (const sessionID of legacyIDs) {
      const legacy = db
        .query<LegacySession, [string]>("SELECT id, agent, model, revert, time_compacting FROM session WHERE id = ?")
        .get(sessionID)
      const actualSession = db.query<V2Session, [string]>("SELECT * FROM session_v2 WHERE id = ?").get(sessionID)
      if (!legacy || !actualSession) continue

      const sourceMessages = db
        .query<
          SourceMessage,
          [string]
        >("SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ?")
        .all(sessionID)
      const sourceParts = db
        .query<
          SourcePart,
          [string]
        >(hasPartSequence ? "SELECT id, message_id, session_id, time_created, time_updated, seq, data FROM part WHERE session_id = ?" : "SELECT id, message_id, session_id, time_created, time_updated, NULL AS seq, data FROM part WHERE session_id = ?")
        .all(sessionID)
      const inputSession = {
        ...actualSession,
        agent: legacy.agent,
        model: parseJson(legacy.model),
        revert: parseJson(legacy.revert),
        time_compacting: legacy.time_compacting,
      } as unknown as TransformInput["session"]
      const expected = transformSession({ session: inputSession, messages: sourceMessages, parts: sourceParts })
      warningCount += expected.warnings.length
      for (const item of expected.warnings) warning(item)

      const actualMessages = db
        .query<
          V2Message,
          [string]
        >("SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq")
        .all(sessionID)
      if (actualMessages.length !== expected.messages.length) {
        mismatchCount++
        mismatch({
          reason: "message-count",
          sessionID,
          expected: expected.messages.length,
          actual: actualMessages.length,
        })
      }
      for (let index = 0; index < Math.min(actualMessages.length, expected.messages.length); index++) {
        const actual = actualMessages[index]
        const projected = expected.messages[index]
        const equal =
          actual.id === projected.id &&
          actual.session_id === projected.session_id &&
          actual.type === projected.type &&
          actual.seq === projected.seq &&
          actual.time_created === projected.time_created &&
          actual.time_updated === projected.time_updated &&
          same(parseJson(actual.data), projected.data)
        if (equal) continue
        mismatchCount++
        mismatch({
          reason: "message",
          sessionID,
          index,
          expected: projected,
          actual: { ...actual, data: parseJson(actual.data) },
        })
      }

      const expectedSession = expected.session
      const aggregates = {
        agent: [actualSession.agent, expectedSession.agent],
        model: [parseJson(actualSession.model), expectedSession.model],
        cost: [actualSession.cost, expectedSession.cost],
        tokens_input: [actualSession.tokens_input, expectedSession.tokens_input],
        tokens_output: [actualSession.tokens_output, expectedSession.tokens_output],
        tokens_reasoning: [actualSession.tokens_reasoning, expectedSession.tokens_reasoning],
        tokens_cache_read: [actualSession.tokens_cache_read, expectedSession.tokens_cache_read],
        tokens_cache_write: [actualSession.tokens_cache_write, expectedSession.tokens_cache_write],
        revert: [parseJson(actualSession.revert), expectedSession.revert],
        time_compacting: [actualSession.time_compacting, expectedSession.time_compacting],
      } as const
      for (const [field, [actual, projected]] of Object.entries(aggregates)) {
        if (same(actual, projected)) continue
        mismatchCount++
        mismatch({ reason: "session-field", sessionID, field, expected: projected, actual })
      }

      const sequence = db
        .query<{ seq: number }, [string]>("SELECT seq FROM event_sequence WHERE aggregate_id = ?")
        .get(sessionID)
      if (sequence?.seq !== expected.watermark) {
        mismatchCount++
        mismatch({ reason: "watermark", sessionID, expected: expected.watermark, actual: sequence?.seq ?? null })
      }

      comparedSessions++
      if (comparedSessions % 100 === 0) console.error(`Compared ${comparedSessions}/${legacyIDs.length} sessions`)
    }

    const migrationStateRaw = db
      .query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'migration.v1-v2'")
      .get()?.value
    const migrationState = migrationStateRaw ? parseJson(migrationStateRaw) : null
    const integrityCheck = values(db.query("PRAGMA integrity_check").all() as Record<string, unknown>[])
    const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all() as Record<string, unknown>[]
    const result = {
      databasePath,
      bytes: statSync(databasePath).size,
      quickCheck: quickCheck(db),
      integrityCheck,
      foreignKeyViolationCount: foreignKeyViolations.length,
      foreignKeyViolationSamples: foreignKeyViolations.slice(0, sampleLimit),
      migrationState,
      counts: counts(db),
      comparedSessions,
      warningCount,
      warningSamples: warnings,
      mismatchCount,
      mismatchSamples: mismatches,
      missingSessionCount,
      missingSessionSamples: missingSessions,
      extraSessionCount,
      extraSessionSamples: extraSessions,
    }
    return {
      ...result,
      passed:
        result.quickCheck.length === 1 &&
        result.quickCheck[0] === "ok" &&
        integrityCheck.length === 1 &&
        integrityCheck[0] === "ok" &&
        foreignKeyViolations.length === 0 &&
        same(migrationState, { phase: "completed" }) &&
        result.counts.event === 0 &&
        result.mismatchCount === 0 &&
        result.missingSessionCount === 0 &&
        result.extraSessionCount === 0,
    }
  } finally {
    db.close()
  }
}

const selected = command as Command
const result =
  selected === "inspect-source" ? inspectSource() : selected === "checkpoint-copy" ? checkpointCopy() : verifyMigrated()
process.stdout.write(JSON.stringify(result))
process.stdout.write("\n")
