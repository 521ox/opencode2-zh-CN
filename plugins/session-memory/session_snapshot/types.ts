export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type RawSessionRow = {
  id: string
  project_id: string
  workspace_id: string | null
  parent_id: string | null
  directory: string
  path: string | null
  title: string
  agent: string | null
  model: string | null
  time_created: number
  time_updated: number
  time_compacting: number | null
}

export type RawMessageRow = {
  id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

export type RawPartRow = {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

export type SubagentSessionReference = {
  session_id: string
  title: string
}

export type HydratedMessage = {
  row: RawMessageRow
  data: JsonObject
  parts: Array<{
    row: RawPartRow
    data: JsonObject
  }>
}

export type SessionSourceSnapshot = {
  session: RawSessionRow
  subagentSessions: SubagentSessionReference[]
  messages: HydratedMessage[]
  rawMessages: RawMessageRow[]
  rawParts: RawPartRow[]
  snapshotStartedAt: string
  maxMessageTime: number
  maxPartTime: number
  compactionMessageIDs: string[]
  firstMessageID: string | null
  lastMessageID: string | null
  dataVersionBefore: number
  dataVersionAfter: number
  messageRowBytes: number
  partRowBytes: number
}

export type SessionSourceStreamStats = {
  sourceMessageCount: number
  sourcePartCount: number
  messageRowBytes: number
  partRowBytes: number
  maxMessageTime: number
  maxPartTime: number
  compactionCount: number
  firstMessageID: string | null
  lastMessageID: string | null
}

export type SessionSourceStream = {
  session: RawSessionRow
  subagentSessions: SubagentSessionReference[]
  snapshotStartedAt: string
  dataVersionBefore: number
  dataVersionAfter: number
  stats: SessionSourceStreamStats
  messages(): Iterable<HydratedMessage>
}

export type RedactionStatus = "eligible" | "ineligible" | "unknown"

export type RedactionResult = {
  text: string
  status: RedactionStatus
  redactedCount: number
  unknownCount: number
  categories: string[]
  failureClasses: string[]
}

export type SnapshotSession = Omit<RawSessionRow, "model"> & { model: JsonValue | null }

export type CleanPart = {
  id: string
  type: string
  tool?: string
  call_id?: string
  status?: string
  title?: string
  text?: string
  data?: JsonValue
  input?: JsonValue
  output?: JsonValue
  error?: JsonValue
  metadata?: JsonValue
}

export type CleanMessage = {
  id: string
  time_created: number
  time_updated: number
  role: string
  summary: boolean
  agent: string | null
  model: JsonValue | null
  parts: CleanPart[]
}

export type CleaningBucket = {
  kept: number
  compressed: number
  dropped: number
  input_bytes: number
  retained_bytes: number
}

export type CleaningStats = {
  policy: "continuity-first-v1"
  input: {
    message_rows: number
    part_rows: number
    message_bytes: number
    part_bytes: number
    total_bytes: number
  }
  output: {
    messages: number
    parts: number
    retained_payload_bytes: number
  }
  part_types: Record<string, CleaningBucket>
  tools: Record<string, CleaningBucket>
}

export type SnapshotMessageLine = {
  index: number
  line: number
  end_line: number
  id: string
  role: string
  agent: string | null
  summary: boolean
  time_created: number
  time_iso: string
  part_count: number
}

export type SnapshotTimeDivision = {
  key: string
  start_time_iso: string
  end_time_iso: string
  start_line: number
  end_line: number
  message_count: number
  first_message_id: string
  last_message_id: string
}

export type SessionSnapshotNavigationDocument = {
  schema_version: 1
  snapshot_schema_version: 5
  session_id: string
  snapshot_created_at: string
  snapshot_file: "snapshot.json"
  snapshot_sha256: string
  total_lines: number
  total_bytes: number
  direct_read_max_lines: number
  read_from_start_allowed: boolean
  line_numbering: string
  sections: Array<{ name: string; start_line: number; end_line: number }>
  messages_start_line: number
  messages_end_line: number
  message_count: number
  time_span: {
    start_time: number
    end_time: number
    start_time_iso: string
    end_time_iso: string
  } | null
  time_divisions: SnapshotTimeDivision[]
}

export type SessionSnapshotDocument = {
  schema_version: 5
  snapshot: {
    session_id: string
    created_at: string
    source_message_count: number
    source_part_count: number
    retained_message_count: number
    retained_part_count: number
    compaction_count: number
    subagent_session_count: number
    first_message_id: string | null
    last_message_id: string | null
    max_message_time: number
    max_part_time: number
    data_version_before: number
    data_version_after: number
    redaction: Omit<RedactionResult, "text">
    cleaning: CleaningStats
  }
  session: SnapshotSession
  subagent_sessions: SubagentSessionReference[]
  messages: CleanMessage[]
}

export type SnapshotCreateResult = {
  session_id: string
  cleanup: false
  directory: string
  path: string
  navigation_path: string
  source_message_count: number
  source_part_count: number
  retained_message_count: number
  retained_part_count: number
  compaction_count: number
  subagent_session_count: number
  bytes: number
  navigation_bytes: number
  navigation_lines: number
  source_bytes: number
  retention_ratio: number
  redacted_count: number
  total_lines: number
  messages_start_line: number
  messages_end_line: number
  time_division_count: number
  time_span: SessionSnapshotNavigationDocument["time_span"]
}

export type SnapshotCleanupResult = {
  session_id: string
  cleanup: true
  directory: string
  deleted: boolean
  removed_directories: number
  removed_legacy_files: number
}
