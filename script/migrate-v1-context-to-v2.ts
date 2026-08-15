#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { existsSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const INPUT_ITEM_LIMIT = 16_384
const STRING_LENGTH_LIMIT = 10_485_760
const REPORT_SAMPLE_LIMIT = 50

type Command = "dry-run" | "apply"

type Options = {
  readonly command: Command
  readonly databasePath: string
  readonly sessionID?: string
  readonly reportPath?: string
  readonly confirmedBackup?: string
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

type LegacyRemote = {
  readonly providerID: string
  readonly modelID: string
  readonly sdk: "opencode-openai"
  readonly output: ReadonlyArray<Record<string, Json>>
}

type LegacyPartRow = {
  readonly id: string
  readonly message_id: string
  readonly session_id: string
  readonly time_created: number
  readonly time_updated: number
  readonly seq: number | null
  readonly data: string
}

type V2MessageRow = {
  readonly id: string
  readonly session_id: string
  readonly type: string
  readonly seq: number
  readonly time_created: number
  readonly time_updated: number
  readonly data: string
}

type RemoteCandidate = {
  readonly part: LegacyPartRow
  readonly anchor: V2MessageRow
  readonly remote: LegacyRemote
  readonly compactionID: string
  readonly outputItems: number
  readonly outputChars: number
  readonly localToolCallIDs: ReadonlyArray<string>
  readonly providerExecutedToolCallIDs: ReadonlyArray<string>
}

type WireStats = {
  readonly messages: number
  readonly estimatedItems: number
  readonly maxStringLength: number
}

type Classification =
  | "remote-ready"
  | "already-migrated"
  | "already-bounded"
  | "no-checkpoint-within-wire-limits"
  | "unresolved-no-checkpoint"
  | "unresolved-local-compaction"
  | "unusable-remote-checkpoint"
  | "missing-v2-session"

type Analysis = {
  readonly sessionID: string
  readonly classification: Classification
  readonly reason: string
  readonly candidate?: RemoteCandidate
  readonly wire?: WireStats
}

type Sample = {
  readonly sessionID: string
  readonly reason: string
  readonly anchorMessageID?: string
  readonly checkpointItems?: number
  readonly checkpointChars?: number
  readonly localToolCalls?: number
  readonly providerExecutedToolCalls?: number
  readonly messages?: number
  readonly estimatedItems?: number
  readonly maxStringLength?: number
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  bun script/migrate-v1-context-to-v2.ts dry-run <database> [--session <session-id>] [--report <json-path>]",
      "  bun script/migrate-v1-context-to-v2.ts apply <database> --confirm-backup <database-copy> [--session <session-id>] [--report <json-path>]",
      "",
      "The database must already contain both the retained V1 tables and the migrated V2 tables.",
      "Stop every OpenCode process before applying this script to the active database.",
    ].join("\n"),
  )
}

function normalizedPath(value: string) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function samePathOrFile(left: string, right: string) {
  if (normalizedPath(left) === normalizedPath(right)) return true
  if (!existsSync(left) || !existsSync(right)) return false
  const leftStat = statSync(left)
  const rightStat = statSync(right)
  return leftStat.dev === rightStat.dev && leftStat.ino !== 0 && leftStat.ino === rightStat.ino
}

function assertSafeReportPath(reportPath: string | undefined, protectedPaths: ReadonlyArray<string | undefined>) {
  if (!reportPath) return
  for (const protectedPath of protectedPaths) {
    if (!protectedPath) continue
    for (const artifact of [protectedPath, `${protectedPath}-wal`, `${protectedPath}-shm`]) {
      if (samePathOrFile(reportPath, artifact))
        throw new Error(`Report path must not overwrite a database or its sidecars: ${reportPath}`)
    }
  }
}

function parseOptions(): Options {
  const args = process.argv.slice(2)
  const command = args.shift()
  const database = args.shift()
  if ((command !== "dry-run" && command !== "apply") || !database) return usage()
  let sessionID: string | undefined
  let reportPath: string | undefined
  let confirmedBackup: string | undefined
  while (args.length > 0) {
    const flag = args.shift()
    const value = args.shift()
    if (!value) return usage()
    if (flag === "--session") sessionID = value
    else if (flag === "--report") reportPath = path.resolve(value)
    else if (flag === "--confirm-backup") confirmedBackup = path.resolve(value)
    else return usage()
  }
  const databasePath = path.resolve(database)
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error(`Database does not exist: ${databasePath}`)
  }
  if (command === "apply") {
    if (!confirmedBackup) throw new Error("apply requires --confirm-backup <database-copy>")
    if (!existsSync(confirmedBackup) || !statSync(confirmedBackup).isFile()) {
      throw new Error(`Confirmed backup does not exist: ${confirmedBackup}`)
    }
    if (samePathOrFile(confirmedBackup, databasePath))
      throw new Error("Backup path must be an independent file from the target database")
  }
  assertSafeReportPath(reportPath, [databasePath, confirmedBackup])
  return { command, databasePath, sessionID, reportPath, confirmedBackup }
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isJson(value: unknown, parents: Set<object>): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return false
  if (parents.has(value)) return false
  parents.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJson(item, parents))
    : isRecord(value) && Object.values(value).every((item) => isJson(item, parents))
  parents.delete(value)
  return valid
}

function isOutputItem(value: unknown): value is Record<string, Json> & { readonly type: string } {
  return isRecord(value) && typeof value.type === "string" && isJson(value, new Set())
}

function isCompactionItem(value: unknown) {
  return (
    isOutputItem(value) &&
    (value.type === "compaction" || value.type === "compaction_summary") &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0
  )
}

function isRemoteOutput(value: unknown): value is ReadonlyArray<Record<string, Json>> {
  if (!Array.isArray(value) || value.length === 0) return false
  let hasCompaction = false
  for (const item of value) {
    if (!isOutputItem(item)) return false
    if (item.type === "redacted" && item.reason === "opaque-remote-compaction") return false
    if (item.type === "compaction" || item.type === "compaction_summary") {
      if (!isCompactionItem(item)) return false
      hasCompaction = true
    }
  }
  return hasCompaction
}

function decodeRemote(row: LegacyPartRow): LegacyRemote | undefined {
  const data = parseJson(row.data)
  if (!isRecord(data) || data.type !== "compaction" || !isRecord(data.remote)) return undefined
  const remote = data.remote
  if (
    typeof remote.providerID !== "string" ||
    typeof remote.modelID !== "string" ||
    remote.sdk !== "opencode-openai" ||
    !isRemoteOutput(remote.output)
  )
    return undefined
  return {
    providerID: remote.providerID,
    modelID: remote.modelID,
    sdk: "opencode-openai",
    output: structuredClone(remote.output),
  }
}

function remoteFunctionCallIDs(output: ReadonlyArray<Record<string, Json>>) {
  const ids = new Set<string>()
  for (const item of output) {
    if (item.type !== "function_call") continue
    if (typeof item.call_id === "string" && item.call_id.length > 0) ids.add(item.call_id)
    if (typeof item.id === "string" && item.id.length > 0) ids.add(item.id)
  }
  return ids
}

function matchesRemoteFunctionCall(callID: string, ids: ReadonlySet<string>) {
  if (ids.has(callID)) return true
  if (callID.startsWith("call_") && ids.has(`fc_${callID.slice("call_".length)}`)) return true
  if (callID.startsWith("fc_") && ids.has(`call_${callID.slice("fc_".length)}`)) return true
  return false
}

function checkpointToolPlan(
  db: Database,
  sessionID: string,
  anchor: V2MessageRow,
  output: ReadonlyArray<Record<string, Json>>,
) {
  const sourceRows = db
    .query<
      Pick<LegacyPartRow, "data">,
      [string, string]
    >("SELECT data FROM part WHERE session_id = ? AND message_id = ? AND json_extract(data, '$.type') = 'tool' ORDER BY COALESCE(seq, 0), time_created, id")
    .all(sessionID, anchor.id)
  const localToolCallIDs: string[] = []
  const providerExecutedToolCallIDs: string[] = []
  const sourceCallIDs = new Set<string>()
  for (const row of sourceRows) {
    const source = parseJson(row.data)
    if (!isRecord(source) || source.type !== "tool" || typeof source.callID !== "string" || !source.callID)
      return undefined
    if (sourceCallIDs.has(source.callID)) return undefined
    sourceCallIDs.add(source.callID)
    const providerExecuted = isRecord(source.metadata) && source.metadata.providerExecuted === true
    if (providerExecuted) providerExecutedToolCallIDs.push(source.callID)
    else localToolCallIDs.push(source.callID)
  }

  const anchorData = parseJson(anchor.data)
  if (!isRecord(anchorData) || !Array.isArray(anchorData.content)) return undefined
  const anchorToolCallIDs = new Set<string>()
  for (const item of anchorData.content) {
    if (!isRecord(item) || item.type !== "tool") continue
    if (typeof item.id !== "string" || !item.id || anchorToolCallIDs.has(item.id)) return undefined
    anchorToolCallIDs.add(item.id)
  }
  if ([...sourceCallIDs].some((callID) => !anchorToolCallIDs.has(callID))) return undefined

  const remoteCallIDs = remoteFunctionCallIDs(output)
  if (localToolCallIDs.some((callID) => !matchesRemoteFunctionCall(callID, remoteCallIDs))) return undefined
  return { localToolCallIDs, providerExecutedToolCallIDs }
}

function compactionID(sessionID: string, partID: string) {
  const hash = new Bun.CryptoHasher("sha256").update(`v1-remote-context:${sessionID}:${partID}`).digest("hex")
  return `msg_v1remote_${hash.slice(0, 24)}`
}

function tableExists(db: Database, name: string) {
  return (
    db
      .query<{ found: number }, [string]>("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== null
  )
}

function assertDatabaseContract(db: Database) {
  const required = ["session", "message", "part", "session_v2", "session_message", "event_sequence", "kv"]
  const missing = required.filter((name) => !tableExists(db, name))
  if (missing.length > 0) throw new Error(`Database is missing required V1/V2 tables: ${missing.join(", ")}`)
  const state = db.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'migration.v1-v2'").get()?.value
  const parsed = state ? parseJson(state) : undefined
  if (!isRecord(parsed) || parsed.phase !== "completed") {
    throw new Error("V1 to V2 migration is not completed; this repair script must run after the normal migration")
  }
}

function modelProvider(db: Database, sessionID: string): string | undefined {
  const raw = db
    .query<{ model: string | null }, [string]>("SELECT model FROM session_v2 WHERE id = ?")
    .get(sessionID)?.model
  if (!raw) return undefined
  const model = parseJson(raw)
  return isRecord(model) && typeof model.providerID === "string" ? model.providerID : undefined
}

function maxStringLength(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") return value.length
  if (!value || typeof value !== "object" || seen.has(value)) return 0
  seen.add(value)
  const values = Array.isArray(value) ? value : Object.values(value)
  let maximum = 0
  for (const item of values) maximum = Math.max(maximum, maxStringLength(item, seen))
  seen.delete(value)
  return maximum
}

function estimatedItems(type: string, data: unknown) {
  if (type === "compaction" || type === "agent-switched" || type === "model-switched") return 0
  if (type !== "assistant" || !isRecord(data) || !Array.isArray(data.content)) return 1
  let items = 0
  for (const content of data.content) {
    if (!isRecord(content)) {
      items++
      continue
    }
    items += content.type === "tool" ? 2 : 1
  }
  return Math.max(items, 1)
}

function wireStats(db: Database, sessionID: string): WireStats {
  const rows = db
    .query<
      Pick<V2MessageRow, "type" | "data">,
      [string]
    >("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq")
    .all(sessionID)
  let items = 0
  let maximum = 0
  for (const row of rows) {
    const data = parseJson(row.data)
    items += estimatedItems(row.type, data)
    maximum = Math.max(maximum, maxStringLength(data))
  }
  return { messages: rows.length, estimatedItems: items, maxStringLength: maximum }
}

function latestCompletedCompaction(db: Database, sessionID: string) {
  return db
    .query<
      Pick<V2MessageRow, "id" | "seq" | "data">,
      [string]
    >("SELECT id, seq, data FROM session_message WHERE session_id = ? AND type = 'compaction' AND json_extract(data, '$.status') = 'completed' ORDER BY seq DESC LIMIT 1")
    .get(sessionID)
}

function findRemoteCandidate(db: Database, sessionID: string, providerID: string | undefined) {
  const parts = db
    .query<
      LegacyPartRow,
      [string]
    >("SELECT id, message_id, session_id, time_created, time_updated, seq, data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'compaction' AND json_type(data, '$.remote') = 'object' ORDER BY (SELECT seq FROM session_message WHERE session_id = part.session_id AND id = part.message_id AND type = 'assistant' LIMIT 1) DESC, COALESCE(seq, 0) DESC, time_created DESC, id DESC")
    .all(sessionID)
  const unusable = parts.length > 0
  for (const part of parts) {
    const remote = decodeRemote(part)
    if (!remote || (providerID !== undefined && remote.providerID !== providerID)) continue
    const anchor = db
      .query<
        V2MessageRow,
        [string, string]
      >("SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? AND id = ? AND type = 'assistant'")
      .get(sessionID, part.message_id)
    if (!anchor) continue
    const tools = checkpointToolPlan(db, sessionID, anchor, remote.output)
    if (!tools) continue
    const id = compactionID(sessionID, part.id)
    const existing = db
      .query<
        Pick<V2MessageRow, "id" | "session_id" | "type" | "seq" | "data">,
        [string]
      >("SELECT id, session_id, type, seq, data FROM session_message WHERE id = ?")
      .get(id)
    if (existing) {
      const data = parseJson(existing.data)
      const migration = isRecord(data) && isRecord(data.metadata) ? data.metadata.migration : undefined
      if (
        existing.session_id === sessionID &&
        existing.type === "compaction" &&
        existing.seq === anchor.seq + 1 &&
        isRecord(data) &&
        data.status === "completed" &&
        JSON.stringify(data.remote) === JSON.stringify(remote.output) &&
        isRecord(migration) &&
        migration.source === "v1-remote-context" &&
        migration.partID === part.id
      )
        return { state: "already-migrated" as const }
      throw new Error(`Deterministic compaction ID collision: ${id}`)
    }
    const outputText = JSON.stringify(remote.output)
    return {
      state: "ready" as const,
      candidate: {
        part,
        anchor,
        remote,
        compactionID: id,
        outputItems: remote.output.length,
        outputChars: outputText.length,
        localToolCallIDs: tools.localToolCallIDs,
        providerExecutedToolCallIDs: tools.providerExecutedToolCallIDs,
      } satisfies RemoteCandidate,
    }
  }
  return { state: unusable ? ("unusable" as const) : ("absent" as const) }
}

function hasLegacyLocalCompaction(db: Database, sessionID: string) {
  return (
    db
      .query<
        { found: number },
        [string]
      >("SELECT 1 AS found FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'compaction' AND json_type(data, '$.remote') IS NULL LIMIT 1")
      .get(sessionID) !== null
  )
}

function analyzeSession(db: Database, sessionID: string): Analysis {
  const v2 = db.query<{ found: number }, [string]>("SELECT 1 AS found FROM session_v2 WHERE id = ?").get(sessionID)
  if (!v2) return { sessionID, classification: "missing-v2-session", reason: "Legacy session has no V2 session row" }
  const completed = latestCompletedCompaction(db, sessionID)
  const remote = findRemoteCandidate(db, sessionID, modelProvider(db, sessionID))
  if (remote.state === "already-migrated")
    return {
      sessionID,
      classification: "already-migrated",
      reason: "The deterministic V1 remote context checkpoint is already present",
    }
  if (remote.state === "ready") {
    if (completed && completed.seq >= remote.candidate.anchor.seq)
      return {
        sessionID,
        classification: "already-bounded",
        reason: "A completed V2 compaction already follows the V1 remote checkpoint anchor",
      }
    return {
      sessionID,
      classification: "remote-ready",
      reason: "A valid provider-compatible V1 remote checkpoint and V2 assistant anchor are available",
      candidate: remote.candidate,
    }
  }
  if (completed)
    return {
      sessionID,
      classification: "already-bounded",
      reason: "The session already has a completed V2 compaction",
    }
  const stats = wireStats(db, sessionID)
  if (remote.state === "unusable")
    return {
      sessionID,
      classification: "unusable-remote-checkpoint",
      reason: "V1 remote checkpoint rows exist but none are valid and compatible with the current provider",
      wire: stats,
    }
  if (hasLegacyLocalCompaction(db, sessionID))
    return {
      sessionID,
      classification: "unresolved-local-compaction",
      reason: "A legacy local compaction exists but no completed V2 compaction was found",
      wire: stats,
    }
  if (stats.estimatedItems <= INPUT_ITEM_LIMIT && stats.maxStringLength <= STRING_LENGTH_LIMIT)
    return {
      sessionID,
      classification: "no-checkpoint-within-wire-limits",
      reason: "No V1 checkpoint exists and the conservatively estimated V2 history remains within wire limits",
      wire: stats,
    }
  return {
    sessionID,
    classification: "unresolved-no-checkpoint",
    reason: "No trustworthy V1 checkpoint exists and the V2 history exceeds a provider wire limit",
    wire: stats,
  }
}

function normalizeProviderExecutedTools(db: Database, candidate: RemoteCandidate) {
  if (candidate.providerExecutedToolCallIDs.length === 0) return 0
  const providerExecuted = new Set(candidate.providerExecutedToolCallIDs)
  const data = parseJson(candidate.anchor.data)
  if (!isRecord(data) || !Array.isArray(data.content))
    throw new Error(`Checkpoint assistant is malformed: ${candidate.anchor.id}`)
  let normalized = 0
  const content = data.content.map((value) => {
    if (!isRecord(value) || value.type !== "tool" || typeof value.id !== "string" || !providerExecuted.has(value.id))
      return value
    normalized++
    const providerState = isRecord(value.providerState) ? { ...value.providerState } : value.providerState
    if (isRecord(providerState)) delete providerState.providerExecuted
    return {
      ...value,
      executed: true,
      ...(isRecord(providerState) && Object.keys(providerState).length === 0
        ? { providerState: undefined }
        : { providerState }),
    }
  })
  if (normalized !== providerExecuted.size)
    throw new Error(`Checkpoint assistant is missing provider-executed tools: ${candidate.anchor.id}`)
  db.query("UPDATE session_message SET data = ? WHERE id = ? AND session_id = ?").run(
    JSON.stringify({ ...data, content }),
    candidate.anchor.id,
    candidate.part.session_id,
  )
  return normalized
}

function migrateRemoteCandidate(db: Database, candidate: RemoteCandidate) {
  const sessionID = candidate.part.session_id
  const anchorSeq = candidate.anchor.seq
  const insertionSeq = anchorSeq + 1
  const negative = db
    .query<
      { count: number },
      [string]
    >("SELECT COUNT(*) AS count FROM session_message WHERE session_id = ? AND seq < 0")
    .get(sessionID)?.count
  if ((negative ?? 0) !== 0) throw new Error(`Session contains a negative message sequence: ${sessionID}`)
  const maximum =
    db
      .query<
        { value: number },
        [string]
      >("SELECT COALESCE(MAX(seq), -1) AS value FROM session_message WHERE session_id = ?")
      .get(sessionID)?.value ?? -1
  const sequence = db
    .query<{ seq: number }, [string]>("SELECT seq FROM event_sequence WHERE aggregate_id = ?")
    .get(sessionID)
  if (!sequence) throw new Error(`Session event sequence is missing: ${sessionID}`)

  const normalizedProviderTools = normalizeProviderExecutedTools(db, candidate)

  // Keep the checkpoint assistant immediately before the compaction so V2 can replay only its local tool results.
  // Negate first so the unique (session_id, seq) index cannot collide while later rows move by one.
  db.query("UPDATE session_message SET seq = -seq - 1 WHERE session_id = ? AND seq >= ?").run(sessionID, insertionSeq)
  db.query("UPDATE session_message SET seq = -seq WHERE session_id = ? AND seq <= ?").run(sessionID, -insertionSeq - 1)

  const source = parseJson(candidate.part.data)
  const auto = isRecord(source) && source.auto === true
  const data = {
    status: "completed",
    reason: auto ? "auto" : "manual",
    summary: "",
    recent: "",
    remote: structuredClone(candidate.remote.output),
    metadata: {
      migration: {
        source: "v1-remote-context",
        partID: candidate.part.id,
        messageID: candidate.part.message_id,
      },
    },
    time: { created: candidate.part.time_created },
  }
  db.query(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'compaction', ?, ?, ?, ?)",
  ).run(
    candidate.compactionID,
    sessionID,
    insertionSeq,
    candidate.part.time_created,
    candidate.part.time_updated,
    JSON.stringify(data),
  )
  const nextWatermark = Math.max(sequence.seq + 1, maximum + 1)
  db.query("UPDATE event_sequence SET seq = ?, owner_id = NULL WHERE aggregate_id = ?").run(nextWatermark, sessionID)
  return normalizedProviderTools
}

function sample(analysis: Analysis): Sample {
  return {
    sessionID: analysis.sessionID,
    reason: analysis.reason,
    ...(analysis.candidate
      ? {
          anchorMessageID: analysis.candidate.anchor.id,
          checkpointItems: analysis.candidate.outputItems,
          checkpointChars: analysis.candidate.outputChars,
          localToolCalls: analysis.candidate.localToolCallIDs.length,
          providerExecutedToolCalls: analysis.candidate.providerExecutedToolCallIDs.length,
        }
      : {}),
    ...(analysis.wire
      ? {
          messages: analysis.wire.messages,
          estimatedItems: analysis.wire.estimatedItems,
          maxStringLength: analysis.wire.maxStringLength,
        }
      : {}),
  }
}

function run(options: Options) {
  const db = new Database(options.databasePath, { readonly: options.command === "dry-run", strict: true })
  try {
    if (options.command === "apply") {
      db.exec("PRAGMA busy_timeout=5000")
      db.exec("PRAGMA foreign_keys=ON")
    }
    assertDatabaseContract(db)
    const sessionIDs = options.sessionID
      ? [options.sessionID]
      : db
          .query<{ id: string }, []>("SELECT id FROM session ORDER BY id")
          .all()
          .map((row) => row.id)
    const categories = new Map<Classification, number>()
    const samples = new Map<Classification, Sample[]>()
    let changed = 0
    let normalizedProviderTools = 0
    let processed = 0
    const applyOne = db.transaction((sessionID: string) => {
      const analysis = analyzeSession(db, sessionID)
      if (analysis.classification !== "remote-ready" || !analysis.candidate) return analysis
      const normalized = migrateRemoteCandidate(db, analysis.candidate)
      changed++
      normalizedProviderTools += normalized
      return {
        sessionID,
        classification: "already-migrated" as const,
        reason: "Migrated a valid V1 remote context checkpoint",
      }
    })

    for (const sessionID of sessionIDs) {
      const analysis = options.command === "apply" ? applyOne.immediate(sessionID) : analyzeSession(db, sessionID)
      categories.set(analysis.classification, (categories.get(analysis.classification) ?? 0) + 1)
      const current = samples.get(analysis.classification) ?? []
      if (current.length < REPORT_SAMPLE_LIMIT) current.push(sample(analysis))
      samples.set(analysis.classification, current)
      processed++
      if (processed % 100 === 0) console.error(`Analyzed ${processed}/${sessionIDs.length} sessions`)
    }

    const quickCheck =
      options.command === "apply"
        ? db
            .query<{ quick_check: string }, []>("PRAGMA quick_check")
            .all()
            .map((row) => row.quick_check)
        : undefined
    const foreignKeys = options.command === "apply" ? db.query("PRAGMA foreign_key_check").all() : undefined
    const result = {
      schemaVersion: 1,
      mode: options.command,
      databasePath: options.databasePath,
      confirmedBackup: options.confirmedBackup,
      limits: { inputItems: INPUT_ITEM_LIMIT, stringLength: STRING_LENGTH_LIMIT },
      totals: {
        sessions: sessionIDs.length,
        changed,
        normalizedProviderTools,
        categories: Object.fromEntries([...categories.entries()].sort(([left], [right]) => left.localeCompare(right))),
      },
      samples: Object.fromEntries([...samples.entries()].sort(([left], [right]) => left.localeCompare(right))),
      verification:
        options.command === "apply"
          ? {
              quickCheck,
              foreignKeyViolationCount: foreignKeys?.length ?? 0,
              passed: quickCheck?.length === 1 && quickCheck[0] === "ok" && foreignKeys?.length === 0,
            }
          : undefined,
    }
    if (options.reportPath) writeFileSync(options.reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
    return result
  } finally {
    db.close()
  }
}

const options = parseOptions()
const result = run(options)
process.stdout.write(`${JSON.stringify(result)}\n`)
