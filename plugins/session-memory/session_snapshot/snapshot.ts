import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalPrettyJSON } from "./canonical"
import { createSessionCleaner } from "./cleaner"
import { prepareOwnedSnapshotRoot, verifyOwnedSnapshotRoot, type OwnedSnapshotRoot } from "./owned-root"
import {
  isOwnedSnapshotWorkDirectoryName,
  isOwnedSnapshotLockWorkDirectoryName,
  legacySnapshotFilePath,
  resolveOpenCodePaths,
  snapshotBundlePaths,
  snapshotDirectoryPath,
  SNAPSHOT_FILE_NAME,
  SNAPSHOT_NAVIGATION_FILE_NAME,
  type OpenCodePaths,
} from "./paths"
import {
  createPrivacyController,
  scopePrivacyController,
  type PrivacyController,
  type ScopedPrivacyController,
} from "./privacy"
import {
  assertPublishableIdentity,
  assertNoUnredactedSecretsInValue,
  redactStructured,
} from "./redaction"
import { buildNavigationFromSummary, countTextLines, timeBucketKey } from "./navigation"
import { withSessionSnapshotLock, type SessionSnapshotLockOptions } from "./lock"
import { withSessionSourceStream } from "./sqlite"
import { canonicalCompactArrayItem, canonicalProperty, ProtectedStreamWriter, type StreamFileSummary } from "./stream"
import {
  createSnapshotMessageValidation,
  parseSessionSnapshotNavigationAgainstExpected,
  SNAPSHOT_NAVIGATION_ROOT_ORDER,
  verifyConstructedSessionSnapshotFile,
} from "./validation"
import type {
  CleanMessage,
  JsonValue,
  RedactionResult,
  SessionSnapshotDocument,
  SessionSnapshotNavigationDocument,
  SnapshotCleanupResult,
  SnapshotCreateResult,
  SnapshotSession,
  SnapshotTimeDivision,
} from "./types"

type RedactionSummary = Omit<RedactionResult, "text">

type FragmentNavigation = {
  messageCount: number
  minTime: number | null
  maxTime: number | null
  timeDivisions: SnapshotTimeDivision[]
}

function addFragmentNavigationMessage(
  navigation: FragmentNavigation,
  message: CleanMessage,
  startLine: number,
  endLine: number,
): void {
  const time = message.time_created
  const timeIso = new Date(time).toISOString()
  const key = timeBucketKey(time)
  const current = navigation.timeDivisions.at(-1)
  if (current?.key === key) {
    if (timeIso < current.start_time_iso) current.start_time_iso = timeIso
    if (timeIso > current.end_time_iso) current.end_time_iso = timeIso
    current.end_line = endLine
    current.message_count++
    current.last_message_id = message.id
  } else {
    navigation.timeDivisions.push({
      key,
      start_time_iso: timeIso,
      end_time_iso: timeIso,
      start_line: startLine,
      end_line: endLine,
      message_count: 1,
      first_message_id: message.id,
      last_message_id: message.id,
    })
  }
  navigation.minTime = navigation.minTime === null ? time : Math.min(navigation.minTime, time)
  navigation.maxTime = navigation.maxTime === null ? time : Math.max(navigation.maxTime, time)
  navigation.messageCount++
}

export type SessionSnapshotServiceHooks = {
  afterLockAcquired?: (operation: "create" | "cleanup", sessionID: string) => Promise<void> | void
  afterBundleInstall?: (target: string) => Promise<void> | void
  beforeFailedPublishIsolation?: (target: string, failed: string) => Promise<void> | void
  afterPublishCommit?: (target: string) => Promise<void> | void
  beforeBackupCleanup?: (backup: string) => Promise<void> | void
  beforeLegacyCleanup?: (legacy: string) => Promise<void> | void
}

function parseNullableJSON(input: string | null, label: string): JsonValue | null {
  if (input === null) return null
  try {
    return JSON.parse(input) as JsonValue
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

function mergeRedaction(input: Array<Partial<RedactionSummary>>): RedactionSummary {
  const categories = new Set<string>()
  const failureClasses = new Set<string>()
  let redactedCount = 0
  let unknownCount = 0
  for (const item of input) {
    redactedCount += item.redactedCount ?? 0
    unknownCount += item.unknownCount ?? 0
    item.categories?.forEach((category) => categories.add(category))
    item.failureClasses?.forEach((failure) => failureClasses.add(failure))
  }
  return {
    status: unknownCount > 0 ? "unknown" : "eligible",
    redactedCount,
    unknownCount,
    categories: [...categories].sort(),
    failureClasses: [...failureClasses].sort(),
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
}

function createRedactionAccumulator() {
  let redactedCount = 0
  let unknownCount = 0
  const categories = new Set<string>()
  const failureClasses = new Set<string>()
  return {
    add(item: Partial<RedactionSummary>) {
      redactedCount += item.redactedCount ?? 0
      unknownCount += item.unknownCount ?? 0
      item.categories?.forEach((category) => categories.add(category))
      item.failureClasses?.forEach((failure) => failureClasses.add(failure))
    },
    finish(): RedactionSummary {
      return {
        status: unknownCount > 0 ? "unknown" : "eligible",
        redactedCount,
        unknownCount,
        categories: [...categories].sort(),
        failureClasses: [...failureClasses].sort(),
      }
    },
  }
}

async function writeProtectedFileAtomically(
  ownedRoot: OwnedSnapshotRoot,
  target: string,
  contents: string,
  privacy: PrivacyController,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  await verifyOwnedSnapshotRoot(ownedRoot, privacy)
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  let handle: fs.FileHandle | null = null
  let renamed = false
  let published = false
  try {
    handle = await fs.open(temporary, "wx", 0o600)
    await privacy.secureFile(temporary)
    await privacy.verifyFile(temporary)
    await handle.writeFile(contents, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    throwIfAborted(signal)
    await verifyOwnedSnapshotRoot(ownedRoot, privacy)
    await fs.rename(temporary, target)
    renamed = true
    published = true
  } finally {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    if (renamed && !published) await fs.rm(target, { force: true }).catch(() => undefined)
  }
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function removeOwnedDirectory(target: string): Promise<boolean> {
  const stats = await lstatOrNull(target)
  if (!stats) return false
  if (stats.isSymbolicLink()) throw new Error(`Snapshot bundle is a symbolic link or reparse point: ${target}`)
  if (!stats.isDirectory()) throw new Error(`Snapshot bundle path is not a directory: ${target}`)
  await fs.rm(target, { recursive: true })
  return true
}

async function publishBundle(
  ownedRoot: OwnedSnapshotRoot,
  staging: string,
  target: string,
  privacy: ScopedPrivacyController,
  hooks: SessionSnapshotServiceHooks,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  await verifyOwnedSnapshotRoot(ownedRoot, privacy)
  const existing = await lstatOrNull(target)
  if (existing?.isSymbolicLink()) throw new Error(`Snapshot bundle is a symbolic link or reparse point: ${target}`)
  if (existing && !existing.isDirectory()) throw new Error(`Snapshot bundle path is not a directory: ${target}`)

  const backup = `${target}.bundle.${process.pid}.${randomBytes(8).toString("hex")}.bak`
  const failed = `${target}.bundle.${process.pid}.${randomBytes(8).toString("hex")}.failed`
  let movedExisting = false
  let installedNew = false
  let committed = false
  try {
    if (existing) {
      await privacy.verifyDirectory(target)
      await fs.rename(target, backup)
      privacy.invalidateDirectory(target)
      privacy.invalidateFile(path.join(target, SNAPSHOT_FILE_NAME))
      privacy.invalidateFile(path.join(target, SNAPSHOT_NAVIGATION_FILE_NAME))
      movedExisting = true
    }
    throwIfAborted(signal)
    await verifyOwnedSnapshotRoot(ownedRoot, privacy)
    await fs.rename(staging, target)
    privacy.invalidateDirectory(target)
    privacy.invalidateFile(path.join(target, SNAPSHOT_FILE_NAME))
    privacy.invalidateFile(path.join(target, SNAPSHOT_NAVIGATION_FILE_NAME))
    installedNew = true
    await hooks.afterBundleInstall?.(target)
    await privacy.verifyDirectory(target)
    await privacy.verifyFile(path.join(target, SNAPSHOT_FILE_NAME))
    await privacy.verifyFile(path.join(target, SNAPSHOT_NAVIGATION_FILE_NAME))
    committed = true
  } catch (error) {
    const failures: unknown[] = [error]
    if (installedNew) {
      try {
        await hooks.beforeFailedPublishIsolation?.(target, failed)
        await fs.rename(target, failed)
        privacy.invalidateDirectory(target)
        privacy.invalidateFile(path.join(target, SNAPSHOT_FILE_NAME))
        privacy.invalidateFile(path.join(target, SNAPSHOT_NAVIGATION_FILE_NAME))
        installedNew = false
      } catch (isolationError) {
        failures.push(isolationError)
        throw new Error(
          `Snapshot bundle publication failed and the failed candidate could not be isolated. Candidate: ${target}. Previous bundle: ${movedExisting ? backup : "none"}`,
          { cause: new AggregateError(failures) },
        )
      }
    }
    if (movedExisting) {
      try {
        await fs.rename(backup, target)
        privacy.invalidateDirectory(target)
        privacy.invalidateFile(path.join(target, SNAPSHOT_FILE_NAME))
        privacy.invalidateFile(path.join(target, SNAPSHOT_NAVIGATION_FILE_NAME))
        await privacy.verifyDirectory(target)
        await privacy.verifyFile(path.join(target, SNAPSHOT_FILE_NAME))
        await privacy.verifyFile(path.join(target, SNAPSHOT_NAVIGATION_FILE_NAME))
        movedExisting = false
      } catch (restoreError) {
        failures.push(restoreError)
        throw new Error(
          `Snapshot bundle publication failed and the previous bundle could not be restored. Failed candidate: ${failed}. Previous bundle: ${backup}`,
          { cause: new AggregateError(failures) },
        )
      }
    }
    throw error
  } finally {
    if (!committed) await removeOwnedDirectory(staging).catch(() => undefined)
  }

  await Promise.resolve()
    .then(async () => await hooks.afterPublishCommit?.(target))
    .catch(() => undefined)
  if (movedExisting) {
    await Promise.resolve()
      .then(async () => {
        await hooks.beforeBackupCleanup?.(backup)
        await removeOwnedDirectory(backup)
      })
      .catch(() => undefined)
  }
}

export class SessionSnapshotService {
  readonly paths: OpenCodePaths
  private readonly privacy: PrivacyController
  private readonly hooks: SessionSnapshotServiceHooks
  private readonly lockOptions: SessionSnapshotLockOptions

  constructor(
    paths: OpenCodePaths = resolveOpenCodePaths(),
    options: {
      privacy?: PrivacyController
      hooks?: SessionSnapshotServiceHooks
      lock?: SessionSnapshotLockOptions
    } = {},
  ) {
    this.paths = paths
    this.privacy = options.privacy ?? createPrivacyController()
    this.hooks = options.hooks ?? {}
    this.lockOptions = options.lock ?? {}
  }

  async create(sessionID: string, options: { signal?: AbortSignal } = {}): Promise<SnapshotCreateResult> {
    throwIfAborted(options.signal)
    const privacy = scopePrivacyController(this.privacy)
    const ownedRoot = await prepareOwnedSnapshotRoot(this.paths, privacy, { create: true })
    if (!ownedRoot) throw new Error("Failed to establish the owned snapshot root")
    return await withSessionSnapshotLock(
      ownedRoot,
      sessionID,
      privacy,
      async (lease) => {
        await this.hooks.afterLockAcquired?.("create", sessionID)
        await lease.pulse()
        const target = snapshotDirectoryPath(ownedRoot.root, sessionID)
        const staging = path.join(
          ownedRoot.root,
          `${sessionID}.bundle.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
        )
        await fs.mkdir(staging, { mode: 0o700 })
        try {
          await privacy.secureDirectory(staging)
          await privacy.verifyDirectory(staging)

          const fragmentPath = path.join(staging, "messages.fragment")
          const fragment = await withSessionSourceStream(
            this.paths,
            sessionID,
            async (source) => {
              const cleaner = createSessionCleaner()
              const redaction = createRedactionAccumulator()
              const validation = createSnapshotMessageValidation()
              const writer = await ProtectedStreamWriter.open(ownedRoot, fragmentPath, privacy, { secure: false })
              let retainedMessages = 0
              let nextLeasePulseAt = Date.now() + 250
              const fragmentNavigation: FragmentNavigation = {
                messageCount: 0,
                minTime: null,
                maxTime: null,
                timeDivisions: [],
              }
              try {
                for (const message of source.messages()) {
                  throwIfAborted(options.signal)
                  if (Date.now() >= nextLeasePulseAt) {
                    await lease.pulse()
                    nextLeasePulseAt = Date.now() + 250
                  }
                  assertPublishableIdentity(message.row.id, "message.id")
                  for (const part of message.parts) {
                    assertPublishableIdentity(part.row.id, "part.id")
                  }
                  const cleaned = cleaner.clean(message)
                  if (!cleaned) continue
                  for (const part of cleaned.parts) {
                    assertPublishableIdentity(part.call_id, "part.call_id")
                  }
                  const result = redactStructured(cleaned)
                  redaction.add(result)
                  if (result.status !== "eligible") {
                    throw new Error(`Snapshot redaction is ${result.status}: ${result.failureClasses.join(", ")}`)
                  }
                  const payload = result.value as CleanMessage
                  validation.validate(payload)
                  if (retainedMessages > 0) {
                    const separator = writer.write(",\n")
                    if (separator) await separator
                  }
                  const startLine = writer.currentLine
                  const item = writer.write(canonicalCompactArrayItem(payload))
                  if (item) await item
                  addFragmentNavigationMessage(fragmentNavigation, payload, startLine, writer.currentLine)
                  retainedMessages++
                }
                const cleaned = cleaner.finish({
                  messageRows: source.stats.sourceMessageCount,
                  partRows: source.stats.sourcePartCount,
                  messageBytes: source.stats.messageRowBytes,
                  partBytes: source.stats.partRowBytes,
                })
                validation.finish(cleaned.cleaning.output.messages, cleaned.cleaning.output.parts)
                if (retainedMessages !== cleaned.cleaning.output.messages) {
                  throw new Error("Streamed retained message count does not match cleaning statistics")
                }
                await writer.finish({ requireTrailingLF: false, durable: false, verifyPrivacy: false })
                return {
                  cleaning: cleaned.cleaning,
                  maskRedaction: cleaned.maskRedaction,
                  messageRedaction: redaction.finish(),
                  navigation: fragmentNavigation,
                }
              } catch (error) {
                await writer.abort()
                throw error
              }
            },
          )

          const source = fragment.source
          if (source.session.id !== sessionID) {
            throw new Error("Session snapshot source identity does not match the requested session")
          }
          assertPublishableIdentity(source.session.id, "session.id")
          assertPublishableIdentity(source.session.project_id, "session.project_id")
          assertPublishableIdentity(source.session.workspace_id, "session.workspace_id")
          assertPublishableIdentity(source.session.parent_id, "session.parent_id")
          assertPublishableIdentity(source.stats.firstMessageID, "snapshot.first_message_id")
          assertPublishableIdentity(source.stats.lastMessageID, "snapshot.last_message_id")
          source.subagentSessions.forEach((child, index) => {
            assertPublishableIdentity(child.session_id, `subagent_sessions[${index}].session_id`)
          })
          const session: SnapshotSession = {
            ...source.session,
            model: parseNullableJSON(source.session.model, "session.model"),
          }
          const staticRedaction = redactStructured({
            session,
            subagent_sessions: source.subagentSessions,
          })
          if (staticRedaction.status !== "eligible") {
            throw new Error(`Snapshot redaction is ${staticRedaction.status}: ${staticRedaction.failureClasses.join(", ")}`)
          }
          const staticPayload = staticRedaction.value as {
            session: SnapshotSession
            subagent_sessions: SessionSnapshotDocument["subagent_sessions"]
          }
          const redaction = mergeRedaction([
            {
              status: "eligible",
              redactedCount: fragment.value.maskRedaction.redactedCount,
              unknownCount: 0,
              categories: fragment.value.maskRedaction.categories,
              failureClasses: [],
            },
            fragment.value.messageRedaction,
            staticRedaction,
          ])
          if (redaction.status !== "eligible") {
            throw new Error(`Snapshot redaction is ${redaction.status}: ${redaction.failureClasses.join(", ")}`)
          }
          const snapshot = {
            session_id: sessionID,
            created_at: source.snapshotStartedAt,
            source_message_count: source.stats.sourceMessageCount,
            source_part_count: source.stats.sourcePartCount,
            retained_message_count: fragment.value.cleaning.output.messages,
            retained_part_count: fragment.value.cleaning.output.parts,
            compaction_count: source.stats.compactionCount,
            subagent_session_count: staticPayload.subagent_sessions.length,
            first_message_id: source.stats.firstMessageID,
            last_message_id: source.stats.lastMessageID,
            max_message_time: source.stats.maxMessageTime,
            max_part_time: source.stats.maxPartTime,
            data_version_before: source.dataVersionBefore,
            data_version_after: source.dataVersionAfter,
            redaction,
            cleaning: fragment.value.cleaning,
          }

          const snapshotPath = path.join(staging, SNAPSHOT_FILE_NAME)
          const snapshotWriter = await ProtectedStreamWriter.open(ownedRoot, snapshotPath, privacy)
          let constructedFile: StreamFileSummary
          let sections: SessionSnapshotNavigationDocument["sections"]
          let messagesStartLine = 0
          try {
            await snapshotWriter.write('{\n  "schema_version": 5,\n')
            const snapshotStartLine = snapshotWriter.currentLine
            await snapshotWriter.write(canonicalProperty("snapshot", snapshot, true))
            const sessionStartLine = snapshotWriter.currentLine
            await snapshotWriter.write(canonicalProperty("session", staticPayload.session, true))
            const subagentsStartLine = snapshotWriter.currentLine
            await snapshotWriter.write(canonicalProperty("subagent_sessions", staticPayload.subagent_sessions, true))
            messagesStartLine = snapshotWriter.currentLine
            if (snapshot.retained_message_count === 0) {
              await snapshotWriter.write('  "messages": []\n}\n')
            } else {
              await snapshotWriter.write('  "messages": [\n')
              await snapshotWriter.copyFrom(fragmentPath)
              await snapshotWriter.write("\n  ]\n}\n")
            }
            constructedFile = await snapshotWriter.finish({ requireTrailingLF: true })
            const messagesEndLine = constructedFile.total_lines - 1
            sections = [
              { name: "snapshot", start_line: snapshotStartLine, end_line: sessionStartLine - 1 },
              { name: "session", start_line: sessionStartLine, end_line: subagentsStartLine - 1 },
              { name: "subagent_sessions", start_line: subagentsStartLine, end_line: messagesStartLine - 1 },
              { name: "messages", start_line: messagesStartLine, end_line: messagesEndLine },
            ]
          } catch (error) {
            await snapshotWriter.abort()
            throw error
          }
          await fs.rm(fragmentPath)

          const lineOffset = messagesStartLine
          const timeDivisions = fragment.value.navigation.timeDivisions.map((division) => ({
            ...division,
            start_line: division.start_line + lineOffset,
            end_line: division.end_line + lineOffset,
          }))
          const minTime = fragment.value.navigation.minTime
          const maxTime = fragment.value.navigation.maxTime
          const timeSpan = minTime === null || maxTime === null
            ? null
            : {
                start_time: minTime,
                end_time: maxTime,
                start_time_iso: new Date(minTime).toISOString(),
                end_time_iso: new Date(maxTime).toISOString(),
              }
          const verifiedSnapshot = await verifyConstructedSessionSnapshotFile(snapshotPath, {
            file: constructedFile,
            sessionID,
            snapshotCreatedAt: source.snapshotStartedAt,
            sections,
            messages_start_line: messagesStartLine,
            messages_end_line: constructedFile.total_lines - 1,
            message_count: fragment.value.navigation.messageCount,
            time_span: timeSpan,
            time_divisions: timeDivisions,
          })
          await lease.pulse()
          const navigation = buildNavigationFromSummary({
            total_lines: verifiedSnapshot.total_lines,
            total_bytes: verifiedSnapshot.total_bytes,
            sections: verifiedSnapshot.sections,
            messages_start_line: verifiedSnapshot.messages_start_line,
            messages_end_line: verifiedSnapshot.messages_end_line,
            message_count: verifiedSnapshot.message_count,
            time_span: verifiedSnapshot.time_span,
            time_divisions: verifiedSnapshot.time_divisions,
            sessionID: verifiedSnapshot.sessionID,
            snapshotCreatedAt: verifiedSnapshot.snapshotCreatedAt,
            snapshotSha256: verifiedSnapshot.snapshot_sha256,
          })
          const navigationContents = canonicalPrettyJSON(navigation, SNAPSHOT_NAVIGATION_ROOT_ORDER)
          const publishedNavigation = parseSessionSnapshotNavigationAgainstExpected(navigationContents, navigation)
          assertNoUnredactedSecretsInValue(publishedNavigation, `${sessionID}/navigation.json`)
          await writeProtectedFileAtomically(
            ownedRoot,
            path.join(staging, SNAPSHOT_NAVIGATION_FILE_NAME),
            navigationContents,
            privacy,
            options.signal,
          )
          await lease.assertOwned()
          await publishBundle(ownedRoot, staging, target, privacy, this.hooks, options.signal)
          const paths = snapshotBundlePaths(ownedRoot.root, sessionID)
          const legacy = legacySnapshotFilePath(ownedRoot.root, sessionID)
          await Promise.resolve()
            .then(async () => {
              await this.hooks.beforeLegacyCleanup?.(legacy)
              await fs.unlink(legacy)
            })
            .catch(() => undefined)
          const sourceBytes = snapshot.cleaning.input.total_bytes
          return {
            session_id: sessionID,
            cleanup: false,
            directory: paths.directory,
            path: paths.snapshot,
            navigation_path: paths.navigation,
            source_message_count: snapshot.source_message_count,
            source_part_count: snapshot.source_part_count,
            retained_message_count: snapshot.retained_message_count,
            retained_part_count: snapshot.retained_part_count,
            compaction_count: snapshot.compaction_count,
            subagent_session_count: snapshot.subagent_session_count,
            bytes: verifiedSnapshot.total_bytes,
            navigation_bytes: Buffer.byteLength(navigationContents),
            navigation_lines: countTextLines(navigationContents),
            source_bytes: sourceBytes,
            retention_ratio:
              sourceBytes === 0 ? 0 : Number((verifiedSnapshot.total_bytes / sourceBytes).toFixed(4)),
            redacted_count: snapshot.redaction.redactedCount,
            total_lines: publishedNavigation.total_lines,
            messages_start_line: publishedNavigation.messages_start_line,
            messages_end_line: publishedNavigation.messages_end_line,
            time_division_count: publishedNavigation.time_divisions.length,
            time_span: publishedNavigation.time_span,
          }
        } catch (error) {
          await removeOwnedDirectory(staging).catch(() => undefined)
          throw error
        }
      },
      { ...this.lockOptions, signal: options.signal },
    )
  }

  async cleanup(sessionID: string): Promise<SnapshotCleanupResult> {
    const lexicalTarget = snapshotDirectoryPath(this.paths.snapshotRoot, sessionID)
    const privacy = scopePrivacyController(this.privacy)
    const ownedRoot = await prepareOwnedSnapshotRoot(this.paths, privacy, { create: false })
    if (!ownedRoot) {
      return {
        session_id: sessionID,
        cleanup: true,
        directory: lexicalTarget,
        deleted: false,
        removed_directories: 0,
        removed_legacy_files: 0,
      }
    }
    return await withSessionSnapshotLock(
      ownedRoot,
      sessionID,
      privacy,
      async (lease) => {
        await this.hooks.afterLockAcquired?.("cleanup", sessionID)
        await lease.assertOwned()
        await verifyOwnedSnapshotRoot(ownedRoot, privacy)
        const target = snapshotDirectoryPath(ownedRoot.root, sessionID)
        let removedDirectories = (await removeOwnedDirectory(target)) ? 1 : 0
        let removedLegacyFiles = 0
        const legacy = legacySnapshotFilePath(ownedRoot.root, sessionID)
        try {
          await fs.unlink(legacy)
          removedLegacyFiles++
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        let names: string[] = []
        try {
          names = await fs.readdir(ownedRoot.root)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        for (const name of names) {
          if (
            !isOwnedSnapshotWorkDirectoryName(name, sessionID) &&
            !isOwnedSnapshotLockWorkDirectoryName(name, sessionID)
          ) continue
          await lease.assertOwned()
          await verifyOwnedSnapshotRoot(ownedRoot, privacy)
          if (await removeOwnedDirectory(path.join(ownedRoot.root, name))) removedDirectories++
        }
        return {
          session_id: sessionID,
          cleanup: true,
          directory: target,
          deleted: removedDirectories > 0 || removedLegacyFiles > 0,
          removed_directories: removedDirectories,
          removed_legacy_files: removedLegacyFiles,
        }
      },
      this.lockOptions,
    )
  }
}
