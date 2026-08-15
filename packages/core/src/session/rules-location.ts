export * as SessionRulesLocation from "./rules-location.js"

import path from "path"
import { Effect, Schema } from "effect"
import { AbsolutePath } from "../schema.js"
import { SessionSchema } from "./schema.js"
import { SessionStartDirectory } from "./start-directory.js"

export const Key = "core/session-rules-location"
export const Header = "Session rules context data (JSON):"

export function isContext(input: string) {
  return input.startsWith(`${Header}\n`)
}

export const Reason = Schema.Literals([
  "missing-current-session",
  "missing-parent-session",
  "parent-cycle",
  "unsafe-session-id",
  "invalid-root-location",
])
export type Reason = typeof Reason.Type

export const Available = Schema.Struct({
  status: Schema.Literal("available"),
  currentSessionID: SessionSchema.ID,
  rootSessionID: SessionSchema.ID,
  rulesDirectory: AbsolutePath,
})
export type Available = typeof Available.Type

export const Unavailable = Schema.Struct({
  status: Schema.Literal("unavailable"),
  currentSessionID: Schema.Union([SessionSchema.ID, Schema.Literal("unavailable")]),
  rootSessionID: Schema.Literal("unavailable"),
  rulesDirectory: Schema.Literal("unavailable"),
  reason: Reason,
})
export type Unavailable = typeof Unavailable.Type

export const Value = Schema.Union([Available, Unavailable])
export type Value = typeof Value.Type

export type SessionParent = {
  readonly id: SessionSchema.ID
  readonly parentID?: SessionSchema.ID
  readonly startDirectory?: AbsolutePath
}

export type GetSession = (sessionID: SessionSchema.ID) => Effect.Effect<SessionParent | undefined>

export interface ResolveInput {
  readonly currentSessionID: SessionSchema.ID
  readonly currentSession: SessionParent | undefined
  readonly getSession: GetSession
}

export const DIRECTORY_NAME_MAX_LENGTH = 120
const SAFE_SESSION_ID = /^ses[A-Za-z0-9_-]*$/

export function directoryName(sessionID: SessionSchema.ID) {
  if (!SAFE_SESSION_ID.test(sessionID)) return
  return sessionID.length <= DIRECTORY_NAME_MAX_LENGTH ? sessionID : undefined
}

function unavailable(currentSessionID: SessionSchema.ID, reason: Reason): Unavailable {
  return Unavailable.make({
    status: "unavailable",
    currentSessionID: directoryName(currentSessionID) ? currentSessionID : "unavailable",
    rootSessionID: "unavailable",
    rulesDirectory: "unavailable",
    reason,
  })
}

/** Resolves one Session lineage to its immutable root rules directory without filesystem access. */
export const resolve = Effect.fn("SessionRulesLocation.resolve")(function* (input: ResolveInput) {
  if (directoryName(input.currentSessionID) === undefined)
    return unavailable(input.currentSessionID, "unsafe-session-id")
  const initial = input.currentSession
  if (!initial) return unavailable(input.currentSessionID, "missing-current-session")
  let current: SessionParent = initial
  if (current.id !== input.currentSessionID || directoryName(current.id) === undefined)
    return unavailable(input.currentSessionID, "unsafe-session-id")

  const seen = new Set<SessionSchema.ID>([current.id])
  while (current.parentID !== undefined) {
    if (directoryName(current.parentID) === undefined) return unavailable(input.currentSessionID, "unsafe-session-id")
    if (seen.has(current.parentID)) return unavailable(input.currentSessionID, "parent-cycle")
    seen.add(current.parentID)
    const parent = yield* input.getSession(current.parentID)
    if (!parent) return unavailable(input.currentSessionID, "missing-parent-session")
    if (parent.id !== current.parentID || directoryName(parent.id) === undefined)
      return unavailable(input.currentSessionID, "unsafe-session-id")
    current = parent
  }

  const workspaceRoot = SessionStartDirectory.validate(current.startDirectory)
  if (!workspaceRoot) return unavailable(input.currentSessionID, "invalid-root-location")
  const rootDirectoryName = directoryName(current.id)
  if (!rootDirectoryName) return unavailable(input.currentSessionID, "unsafe-session-id")
  const selected = SessionStartDirectory.platform(workspaceRoot)
  if (!selected) return unavailable(input.currentSessionID, "invalid-root-location")
  const rulesRoot = selected.resolve(workspaceRoot, ".opencode", "rules")
  const rulesDirectory = selected.resolve(rulesRoot, rootDirectoryName)
  if (selected.dirname(rulesDirectory) !== rulesRoot) return unavailable(input.currentSessionID, "unsafe-session-id")
  return Available.make({
    status: "available",
    currentSessionID: input.currentSessionID,
    rootSessionID: current.id,
    rulesDirectory: AbsolutePath.make(rulesDirectory),
  })
})

/** Renders the protected, model-visible Session rules location contract. */
export function render(value: Value) {
  const data = JSON.stringify({
    current_session_id: value.currentSessionID,
    root_session_id: value.rootSessionID,
    rules_directory: value.rulesDirectory,
    status: value.status,
    ...(value.status === "unavailable" ? { reason: value.reason } : {}),
  })
  const header = [Header, data]
  if (value.status === "unavailable")
    return [
      ...header,
      "",
      "No session rules directory could be resolved. Do not substitute the current child session ID, guess another location, or search sibling session directories as a fallback.",
      "An explicit user instruction or authoritative project artifact naming a document location still takes precedence.",
    ].join("\n")
  return [
    ...header,
    "",
    "Use this directory first for session-specific rules, plans, architecture notes, and working documents.",
    "The root session and all descendant subagents share this directory.",
    "Create the directory lazily only when a task needs to persist such documents; OpenCode has not checked whether the directory or any document exists.",
    "Do not guess or search another session's rules directory as a fallback.",
    "An explicit user instruction or authoritative project artifact naming another document location takes precedence.",
  ].join("\n")
}
