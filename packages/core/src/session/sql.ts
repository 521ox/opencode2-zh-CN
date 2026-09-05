import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex, check } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { directoryColumn, pathColumn } from "../database/path.js"
import { ProjectTable } from "../project/sql.js"
import type { SessionMessage } from "./message.js"
import type { SessionInbox } from "./inbox.js"
import type { FileDiff } from "@opencode-ai/schema/file-diff"
import { PermissionV1 } from "../v1/permission.js"
import { Project } from "../project.js"
import type { SessionSchema } from "./schema.js"
import { Workspace } from "../workspace.js"
import { Timestamps } from "../database/schema.sql.js"
import type { Instruction } from "@opencode-ai/schema/instruction"
import type { Session } from "@opencode-ai/schema/session"
import type { CompactionPayload, MovePayload, SyntheticPayload, UserPayload } from "@opencode-ai/schema/session-inbox"
import type { RevertV1 } from "@opencode-ai/schema/session-revert"
import type { Schema } from "effect"

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type SessionMessageData = DistributiveOmit<(typeof SessionMessage.Info)["Encoded"], "type" | "id">
type SessionAssistantHeadData = Omit<(typeof SessionMessage.Assistant)["Encoded"], "id" | "type" | "content">
type SessionAssistantPartType = SessionMessage.AssistantContentEncoded["type"]
type SessionSubagentContinuationState = "requested" | "admitted" | "bound" | "completed" | "failed" | "cancelled"
type SessionSubagentTurnState = "active" | "completed" | "failed" | "cancelled"

export const SessionTable = sqliteTable(
  "session_v2",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<Workspace.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    fork_session_id: text().$type<SessionSchema.ID>(),
    fork_boundary: text({ mode: "json" }).$type<Session.ForkBoundary>(),
    slug: text().notNull(),
    directory: directoryColumn().notNull(),
    start_directory: directoryColumn(),
    path: pathColumn(),
    title: text(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<FileDiff.LegacyInfo[]>(),
    metadata: text({ mode: "json" }).$type<Session.Metadata>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Session.Revert | RevertV1>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_idle: integer(),
    time_viewed: integer(),
    idle_outcome: text().$type<NonNullable<Session.Info["outcome"]>>(),
    time_compacting: integer(),
    time_archived: integer(),
    /** The execution claim timestamp (historical column name; see SessionStore.claim). */
    time_suspended: integer(),
    resume_attempts: integer().notNull().default(0),
    claim_owner: text(),
    claim_pid: integer(),
    claim_hostname: text(),
    claim_updated_at: integer(),
    claim_expires_at: integer(),
  },
  (table) => [
    index("session_v2_project_idx").on(table.project_id),
    index("session_v2_workspace_idx").on(table.workspace_id),
    index("session_v2_parent_idx").on(table.parent_id),
    index("session_v2_time_suspended_idx")
      .on(table.time_suspended)
      .where(sql`${table.time_suspended} is not null`),
    index("session_v2_claim_expires_idx")
      .on(table.claim_expires_at)
      .where(sql`${table.claim_expires_at} is not null`),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionAssistantActiveTable = sqliteTable(
  "session_assistant_active",
  {
    message_id: text()
      .$type<SessionMessage.ID>()
      .primaryKey()
      .references(() => SessionMessageTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    data: text({ mode: "json" }).$type<SessionAssistantHeadData>().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("session_assistant_active_session_idx").on(table.session_id)],
)

export const SessionAssistantPartTable = sqliteTable(
  "session_assistant_part",
  {
    message_id: text()
      .$type<SessionMessage.ID>()
      .notNull()
      .references(() => SessionAssistantActiveTable.message_id, { onDelete: "cascade" }),
    position: integer().notNull(),
    type: text().$type<SessionAssistantPartType>().notNull(),
    type_ordinal: integer().notNull(),
    tool_id: text(),
    data: text({ mode: "json" }).$type<SessionMessage.AssistantContentEncoded>().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.message_id, table.position] }),
    uniqueIndex("session_assistant_part_message_type_ordinal_idx").on(table.message_id, table.type, table.type_ordinal),
    check("session_assistant_part_position_check", sql`${table.position} >= 0`),
    check("session_assistant_part_type_ordinal_check", sql`${table.type_ordinal} >= 0`),
    check("session_assistant_part_type_check", sql`${table.type} in ('text', 'reasoning', 'tool')`),
    check(
      "session_assistant_part_tool_id_check",
      sql`(${table.type} = 'tool' and ${table.tool_id} is not null) or (${table.type} <> 'tool' and ${table.tool_id} is null)`,
    ),
    index("session_assistant_part_message_type_position_idx").on(table.message_id, table.type, table.position),
    index("session_assistant_part_message_tool_position_idx")
      .on(table.message_id, table.tool_id, table.position)
      .where(sql`${table.type} = 'tool'`),
  ],
)

export const SessionPendingTable = sqliteTable(
  "session_pending",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionInbox.Info["type"]>().notNull(),
    data: text({ mode: "json" }).$type<UserPayload | SyntheticPayload | Record<string, never>>().notNull(),
    delivery: text().$type<SessionInbox.Delivery>(),
    admitted_seq: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_pending_session_delivery_seq_idx").on(table.session_id, table.delivery, table.admitted_seq),
    uniqueIndex("session_pending_session_compaction_idx")
      .on(table.session_id)
      .where(sql`${table.type} = 'compaction'`),
    uniqueIndex("session_pending_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
  ],
)

export const SessionInboxTable = sqliteTable(
  "session_inbox",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionInbox.Info["type"]>().notNull(),
    payload: text({ mode: "json" }).$type<UserPayload | SyntheticPayload | CompactionPayload | MovePayload>().notNull(),
    delivery: text().$type<SessionInbox.Delivery>().notNull(),
    enqueued_seq: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_inbox_session_delivery_seq_idx").on(table.session_id, table.delivery, table.enqueued_seq),
    uniqueIndex("session_inbox_session_enqueued_seq_idx").on(table.session_id, table.enqueued_seq),
  ],
)

/** Private request-to-turn correlation for subagent tool invocations. */
export const SessionSubagentTurnTable = sqliteTable(
  "session_subagent_turn",
  {
    id: text().primaryKey(),
    child_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    state: text().$type<SessionSubagentTurnState>().notNull(),
    assistant_message_id: text().$type<SessionMessage.ID>(),
    output: text(),
    error: text({ mode: "json" }).$type<{ readonly type: string; readonly message: string }>(),
    time_terminal: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("session_subagent_turn_child_active_idx")
      .on(table.child_session_id)
      .where(sql`${table.state} = 'active'`),
  ],
)

/** Private durable request, Inbox, turn, and terminal-outcome ownership. */
export const SessionSubagentContinuationTable = sqliteTable(
  "session_subagent_continuation",
  {
    id: text().primaryKey(),
    parent_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_message_id: text().$type<SessionMessage.ID>().notNull(),
    parent_tool_call_id: text().notNull(),
    child_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    agent: text().notNull(),
    description: text().notNull(),
    inbox_id: text().$type<SessionMessage.ID>().notNull(),
    turn_id: text().references(() => SessionSubagentTurnTable.id, { onDelete: "set null" }),
    state: text().$type<SessionSubagentContinuationState>().notNull(),
    prompt_digest: text().notNull(),
    time_terminal: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("session_subagent_continuation_parent_call_idx").on(
      table.parent_session_id,
      table.parent_message_id,
      table.parent_tool_call_id,
    ),
    uniqueIndex("session_subagent_continuation_inbox_idx").on(table.inbox_id),
    index("session_subagent_continuation_child_state_idx").on(table.child_session_id, table.state),
    index("session_subagent_continuation_turn_state_idx").on(table.turn_id, table.state),
  ],
)

export const InstructionEntryTable = sqliteTable(
  "instruction_entry",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    key: text().notNull(),
    value: text({ mode: "json" }).$type<Schema.Json>(),
    removed: integer({ mode: "boolean" }).notNull().default(false),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.session_id, table.key] })],
)

export const InstructionBlobTable = sqliteTable("instruction_blob", {
  hash: text().$type<Instruction.Hash>().primaryKey(),
  value: text({ mode: "json" }).$type<Schema.Json>(),
})

export const InstructionStateTable = sqliteTable("instruction_state", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  epoch_start: integer().notNull(),
  through_seq: integer().notNull(),
  initial_values: text({ mode: "json" }).notNull().$type<Instruction.Values>(),
  current_values: text({ mode: "json" }).notNull().$type<Instruction.Values>(),
})
