import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { verifyOwnedSnapshotRoot, type OwnedSnapshotRoot } from "./owned-root"
import { assertSessionID } from "./paths"
import type { PrivacyController } from "./privacy"

const OWNER_FILE = "owner.json"
const TICKET_FILE = "ticket.json"
const ACTIVE_TOKENS = new Set<string>()

type LockOwner = {
  schema_version: 1
  pid: number
  process_identity: string
  token: string
  created_at: string
}

type LockTicket = {
  schema_version: 1
  ticket: number
  token: string
}

type ClaimInspection = {
  owner: LockOwner
  ticket: LockTicket | null
}

export type SessionSnapshotLockHooks = {
  beforeDeadClaimQuarantine?: (input: {
    directory: string
    token: string
    reason: "dead-process" | "pid-reused" | "abandoned-current-process" | "incomplete"
  }) => Promise<void> | void
  beforeReleaseRename?: (input: { directory: string; token: string; attempt: number }) => Promise<void> | void
}

export type SessionSnapshotLockOptions = {
  timeoutMs?: number
  pollMs?: number
  initializationGraceMs?: number
  heartbeatMs?: number
  identityCheckMs?: number
  releaseRetryMs?: number
  releaseTimeoutMs?: number
  hooks?: SessionSnapshotLockHooks
}

export type AcquiredSessionSnapshotLock = {
  directory: string
  token: string
  pulse(): Promise<void>
  assertOwned(): Promise<void>
  release(): Promise<void>
}

function heartbeatFileName(token: string): string {
  return `${token}.heartbeat`
}

function legacyLockDirectory(root: string, sessionID: string): string {
  return path.join(root, `${assertSessionID(sessionID)}.lock`)
}

function claimDirectory(root: string, sessionID: string, token: string): string {
  return path.join(root, `${assertSessionID(sessionID)}.lock.claim.${token}`)
}

function releasedDirectory(root: string, sessionID: string): string {
  return path.join(root, `${assertSessionID(sessionID)}.lock.released.${randomBytes(16).toString("hex")}`)
}

function claimToken(name: string, sessionID: string): string | null {
  const prefix = `${assertSessionID(sessionID)}.lock.claim.`
  if (!name.startsWith(prefix)) return null
  const token = name.slice(prefix.length)
  return /^[a-f0-9]{32}$/.test(token) ? token : null
}

function isNodeError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null
    throw error
  }
}

async function writeProtectedJSON(target: string, value: unknown): Promise<void> {
  const handle = await fs.open(target, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readJSONFile(target: string): Promise<unknown | null> {
  let contents: string
  try {
    const stats = await fs.lstat(target)
    if (stats.isSymbolicLink() || !stats.isFile()) return null
    contents = await fs.readFile(target, "utf8")
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null
    throw error
  }
  try {
    return JSON.parse(contents) as unknown
  } catch {
    return null
  }
}

async function readOwner(target: string): Promise<LockOwner | null> {
  const value = await readJSONFile(target) as Partial<LockOwner> | null
  if (
    !value ||
    value.schema_version !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid ?? 0) <= 0 ||
    typeof value.process_identity !== "string" ||
    value.process_identity.length === 0 ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.token) ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at))
  ) return null
  return value as LockOwner
}

async function readTicket(target: string, token: string): Promise<LockTicket | null> {
  const value = await readJSONFile(target) as Partial<LockTicket> | null
  if (
    !value ||
    value.schema_version !== 1 ||
    !Number.isSafeInteger(value.ticket) ||
    (value.ticket ?? 0) <= 0 ||
    value.token !== token
  ) return null
  return value as LockTicket
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isNodeError(error, "ESRCH")
  }
}

function executeFile(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: "utf8", windowsHide: true, timeout: 10_000, env },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    )
  })
}

async function processIdentity(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
    const value = await executeFile(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$p = Get-Process -Id ([int]$env:SESSION_SNAPSHOT_LOCK_PID) -ErrorAction Stop; [string]$p.StartTime.ToUniversalTime().Ticks",
      ],
      { ...process.env, SESSION_SNAPSHOT_LOCK_PID: String(pid) },
    )
    return value ? `windows:${value}` : null
  }
  if (process.platform === "linux") {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
      const close = stat.lastIndexOf(")")
      if (close < 0) return null
      const startTime = stat.slice(close + 2).trim().split(/\s+/)[19]
      return startTime ? `linux:${startTime}` : null
    } catch {
      return null
    }
  }
  const value = await executeFile("ps", ["-o", "lstart=", "-p", String(pid)])
  return value ? `${process.platform}:${value}` : null
}

async function wait(delayMs: number, signal?: AbortSignal, unref = false): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, delayMs)
    if (unref) timer.unref()
    signal?.addEventListener("abort", abort, { once: true })
  })
}

async function quarantineUniqueClaim(
  ownedRoot: OwnedSnapshotRoot,
  directory: string,
  sessionID: string,
  privacy: PrivacyController,
): Promise<string | null> {
  await verifyOwnedSnapshotRoot(ownedRoot, privacy)
  const stats = await lstatOrNull(directory)
  if (!stats) return null
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Snapshot lock claim is not an owned directory: ${directory}`)
  }
  const quarantine = releasedDirectory(ownedRoot.root, sessionID)
  for (let attempt = 0; attempt <= 100; attempt++) {
    try {
      await fs.rename(directory, quarantine)
      return quarantine
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null
      if (isNodeError(error, "EPERM") || isNodeError(error, "EACCES")) {
        if (!(await lstatOrNull(directory))) return null
        if (attempt < 100) {
          await wait(10)
          continue
        }
      }
      throw error
    }
  }
  throw new Error(`Snapshot lock claim quarantine retry exhausted: ${directory}`)
}

async function removeQuarantine(directory: string | null): Promise<void> {
  if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
}

async function inspectClaim(
  ownedRoot: OwnedSnapshotRoot,
  directory: string,
  sessionID: string,
  token: string,
  privacy: PrivacyController,
  options: Required<Pick<SessionSnapshotLockOptions, "initializationGraceMs" | "identityCheckMs">> & {
    hooks?: SessionSnapshotLockHooks
  },
): Promise<ClaimInspection | null> {
  const stats = await lstatOrNull(directory)
  if (!stats) return null
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Snapshot lock claim is not an owned directory: ${directory}`)
  }
  const owner = await readOwner(path.join(directory, OWNER_FILE))
  const ageMs = Date.now() - stats.mtimeMs
  if (!owner || owner.token !== token) {
    if (ageMs <= options.initializationGraceMs) return { owner: {
      schema_version: 1,
      pid: Number.MAX_SAFE_INTEGER,
      process_identity: "initializing",
      token,
      created_at: new Date(stats.birthtimeMs || stats.ctimeMs).toISOString(),
    }, ticket: null }
    await options.hooks?.beforeDeadClaimQuarantine?.({ directory, token, reason: "incomplete" })
    await removeQuarantine(await quarantineUniqueClaim(ownedRoot, directory, sessionID, privacy))
    return null
  }
  const reap = async (reason: Parameters<NonNullable<SessionSnapshotLockHooks["beforeDeadClaimQuarantine"]>>[0]["reason"]) => {
    await options.hooks?.beforeDeadClaimQuarantine?.({ directory, token, reason })
    await removeQuarantine(await quarantineUniqueClaim(ownedRoot, directory, sessionID, privacy))
  }
  if (owner.pid === process.pid && !ACTIVE_TOKENS.has(owner.token)) {
    await reap("abandoned-current-process")
    return null
  }
  if (!processIsAlive(owner.pid)) {
    await reap("dead-process")
    return null
  }
  const ticket = await readTicket(path.join(directory, TICKET_FILE), token)
  if (!ticket && ageMs > options.initializationGraceMs) {
    await reap("incomplete")
    return null
  }
  const heartbeat = await lstatOrNull(path.join(directory, heartbeatFileName(token)))
  if (heartbeat && (heartbeat.isSymbolicLink() || !heartbeat.isFile())) {
    throw new Error(`Snapshot lock heartbeat has the wrong type: ${directory}`)
  }
  const lastEvidence = heartbeat?.mtimeMs ?? stats.mtimeMs
  if (Date.now() - lastEvidence >= options.identityCheckMs) {
    const identity = await processIdentity(owner.pid)
    if (identity !== null && identity !== owner.process_identity) {
      await reap("pid-reused")
      return null
    }
  }
  return { owner, ticket }
}

async function listClaims(root: string, sessionID: string): Promise<Array<{ directory: string; token: string }>> {
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return []
    throw error
  }
  return names.flatMap((name) => {
    const token = claimToken(name, sessionID)
    return token ? [{ directory: path.join(root, name), token }] : []
  })
}

async function inspectLegacyLock(
  ownedRoot: OwnedSnapshotRoot,
  sessionID: string,
  privacy: PrivacyController,
  initializationGraceMs: number,
  identityCheckMs: number,
): Promise<"absent" | "wait"> {
  const directory = legacyLockDirectory(ownedRoot.root, sessionID)
  const stats = await lstatOrNull(directory)
  if (!stats) return "absent"
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Legacy snapshot lock is not an owned directory: ${directory}`)
  }
  const owner = await readOwner(path.join(directory, OWNER_FILE))
  if (!owner) {
    if (Date.now() - stats.mtimeMs <= initializationGraceMs) return "wait"
    await removeQuarantine(await quarantineUniqueClaim(ownedRoot, directory, sessionID, privacy))
    return "absent"
  }
  if (!processIsAlive(owner.pid)) {
    await removeQuarantine(await quarantineUniqueClaim(ownedRoot, directory, sessionID, privacy))
    return "absent"
  }
  const heartbeat = await lstatOrNull(path.join(directory, heartbeatFileName(owner.token)))
  const lastEvidence = heartbeat?.mtimeMs ?? stats.mtimeMs
  if (Date.now() - lastEvidence < identityCheckMs) return "wait"
  const identity = await processIdentity(owner.pid)
  if (identity === null || identity === owner.process_identity) return "wait"
  await removeQuarantine(await quarantineUniqueClaim(ownedRoot, directory, sessionID, privacy))
  return "absent"
}

function compareTickets(left: LockTicket, right: LockTicket): number {
  if (left.ticket !== right.ticket) return left.ticket - right.ticket
  return left.token.localeCompare(right.token)
}

function validateOptions(options: SessionSnapshotLockOptions) {
  const values = {
    timeoutMs: options.timeoutMs ?? 300_000,
    pollMs: options.pollMs ?? 50,
    initializationGraceMs: options.initializationGraceMs ?? 60_000,
    heartbeatMs: options.heartbeatMs ?? 1_000,
    identityCheckMs: options.identityCheckMs ?? 5_000,
    releaseRetryMs: options.releaseRetryMs ?? 50,
    releaseTimeoutMs: options.releaseTimeoutMs ?? 5_000,
  }
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Snapshot lock ${name} must be a positive integer`)
  }
  if (values.heartbeatMs < 10) throw new Error("Snapshot lock heartbeatMs must be at least 10")
  if (values.identityCheckMs < values.heartbeatMs) {
    throw new Error("Snapshot lock identityCheckMs must be no smaller than heartbeatMs")
  }
  return { ...values, hooks: options.hooks }
}

export async function acquireSessionSnapshotLock(
  ownedRoot: OwnedSnapshotRoot,
  sessionID: string,
  privacy: PrivacyController,
  options: SessionSnapshotLockOptions & { signal?: AbortSignal } = {},
): Promise<AcquiredSessionSnapshotLock> {
  const config = validateOptions(options)
  const currentIdentity = await processIdentity(process.pid)
  if (!currentIdentity) throw new Error("Unable to determine the current process identity for the snapshot lock")
  const startedAt = Date.now()
  const token = randomBytes(16).toString("hex")
  const directory = claimDirectory(ownedRoot.root, sessionID, token)
  const ownerPath = path.join(directory, OWNER_FILE)
  const heartbeatPath = path.join(directory, heartbeatFileName(token))
  const ticketPath = path.join(directory, TICKET_FILE)
  let claimed = false
  let acquired = false

  const assertOwned = async () => {
    const owner = await readOwner(ownerPath)
    const ticket = await readTicket(ticketPath, token)
    if (
      !owner ||
      !ticket ||
      owner.pid !== process.pid ||
      owner.process_identity !== currentIdentity ||
      owner.token !== token
    ) throw new Error(`Snapshot lock ownership changed: ${sessionID}`)
  }

  const discardOwnClaim = async () => {
    ACTIVE_TOKENS.delete(token)
    if (!claimed) return
    const quarantine = await quarantineUniqueClaim(ownedRoot, directory, sessionID, privacy)
    claimed = false
    await removeQuarantine(quarantine)
  }

  try {
    await verifyOwnedSnapshotRoot(ownedRoot, privacy)
    ACTIVE_TOKENS.add(token)
    await fs.mkdir(directory, { mode: 0o700 })
    claimed = true
    await privacy.secureDirectory(directory)
    await privacy.verifyDirectory(directory)
    await writeProtectedJSON(ownerPath, {
      schema_version: 1,
      pid: process.pid,
      process_identity: currentIdentity,
      token,
      created_at: new Date().toISOString(),
    })
    await writeProtectedJSON(heartbeatPath, { schema_version: 1, token })

    let nextTicket = 1
    for (const claim of await listClaims(ownedRoot.root, sessionID)) {
      if (claim.token === token) continue
      const inspected = await inspectClaim(
        ownedRoot,
        claim.directory,
        sessionID,
        claim.token,
        privacy,
        config,
      )
      if (inspected?.ticket) nextTicket = Math.max(nextTicket, inspected.ticket.ticket + 1)
    }
    const ownTicket: LockTicket = { schema_version: 1, ticket: nextTicket, token }
    await writeProtectedJSON(ticketPath, ownTicket)

    let lastPulseAt = 0
    while (true) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException("Aborted", "AbortError")
      }
      if (Date.now() - startedAt >= config.timeoutMs) {
        throw new Error(`Timed out waiting for the session snapshot lock: ${sessionID}`)
      }
      await assertOwned()
      if (Date.now() - lastPulseAt >= config.heartbeatMs) {
        const now = new Date()
        await fs.utimes(heartbeatPath, now, now)
        lastPulseAt = Date.now()
      }
      if (
        await inspectLegacyLock(
          ownedRoot,
          sessionID,
          privacy,
          config.initializationGraceMs,
          config.identityCheckMs,
        ) === "wait"
      ) {
        await wait(config.pollMs, options.signal)
        continue
      }
      let blocked = false
      for (const claim of await listClaims(ownedRoot.root, sessionID)) {
        if (claim.token === token) continue
        const inspected = await inspectClaim(
          ownedRoot,
          claim.directory,
          sessionID,
          claim.token,
          privacy,
          config,
        )
        if (!inspected) continue
        if (!inspected.ticket || compareTickets(inspected.ticket, ownTicket) < 0) {
          blocked = true
          break
        }
      }
      if (!blocked) break
      await wait(config.pollMs, options.signal)
    }

    await assertOwned()
    acquired = true
    let released = false
    let heartbeatError: unknown
    let heartbeatChain = Promise.resolve()
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let lastHeartbeatAt = 0
    const updateHeartbeat = async () => {
      if (released) return
      await assertOwned()
      const now = new Date()
      await fs.utimes(heartbeatPath, now, now)
      lastHeartbeatAt = now.getTime()
    }
    const queueHeartbeat = (force: boolean) => {
      heartbeatChain = heartbeatChain
        .then(async () => {
          if (!force && Date.now() - lastHeartbeatAt < config.heartbeatMs) return
          await updateHeartbeat()
        })
        .catch((error) => { heartbeatError ??= error })
      return heartbeatChain
    }
    const startHeartbeat = () => {
      if (heartbeatTimer || released) return
      heartbeatTimer = setInterval(() => {
        void queueHeartbeat(true)
      }, config.heartbeatMs)
      heartbeatTimer.unref()
    }
    const stopHeartbeat = () => {
      if (!heartbeatTimer) return
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    startHeartbeat()

    let releaseAttempt = 0
    const performRelease = async (): Promise<void> => {
      releaseAttempt++
      await assertOwned()
      await updateHeartbeat()
      await config.hooks?.beforeReleaseRename?.({ directory, token, attempt: releaseAttempt })
      const quarantine = await quarantineUniqueClaim(ownedRoot, directory, sessionID, privacy)
      if (!quarantine) throw new Error(`Snapshot lock disappeared before release: ${sessionID}`)
      released = true
      claimed = false
      ACTIVE_TOKENS.delete(token)
      await removeQuarantine(quarantine)
    }
    const backgroundRelease = async () => {
      while (!released) {
        await wait(config.releaseRetryMs, undefined, true)
        try {
          await performRelease()
        } catch {
          try {
            await updateHeartbeat()
          } catch (error) {
            heartbeatError ??= error
          }
        }
      }
    }
    let releasePromise: Promise<void> | null = null

    return {
      directory,
      token,
      assertOwned,
      pulse: async () => {
        if (!heartbeatError && Date.now() - lastHeartbeatAt < config.heartbeatMs) return
        await queueHeartbeat(false)
        if (heartbeatError) throw new Error(`Session snapshot lock heartbeat failed: ${sessionID}`, { cause: heartbeatError })
      },
      release: async () => {
        if (released) return
        if (releasePromise) return await releasePromise
        releasePromise = (async () => {
          stopHeartbeat()
          await heartbeatChain
          const deadline = Date.now() + config.releaseTimeoutMs
          let lastError: unknown = heartbeatError
          while (!released) {
            try {
              await performRelease()
              return
            } catch (error) {
              lastError = error
            }
            if (Date.now() >= deadline) break
            await wait(config.releaseRetryMs)
          }
          void backgroundRelease()
          throw new Error(
            `Snapshot operation completed but lock release is pending in the background: ${sessionID}`,
            { cause: lastError },
          )
        })()
        return await releasePromise
      },
    }
  } catch (error) {
    if (!acquired) {
      try {
        await discardOwnClaim()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Snapshot lock acquisition and claim cleanup failed: ${sessionID}`)
      }
    }
    throw error
  }
}

export async function withSessionSnapshotLock<T>(
  ownedRoot: OwnedSnapshotRoot,
  sessionID: string,
  privacy: PrivacyController,
  operation: (lock: AcquiredSessionSnapshotLock) => Promise<T>,
  options: SessionSnapshotLockOptions & { signal?: AbortSignal } = {},
): Promise<T> {
  const lock = await acquireSessionSnapshotLock(ownedRoot, sessionID, privacy, options)
  let value: T | undefined
  let operationError: unknown
  try {
    value = await operation(lock)
  } catch (error) {
    operationError = error
  }
  try {
    await lock.release()
  } catch (releaseError) {
    if (operationError) {
      throw new AggregateError([operationError, releaseError], "Snapshot operation and lock release both failed")
    }
    throw releaseError
  }
  if (operationError) throw operationError
  return value as T
}
