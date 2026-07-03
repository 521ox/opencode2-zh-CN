import { spawn } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// Everything a client needs to connect to an opencode server and to find or
// start the local background service.
//
// The service daemon advertises itself through a registration file in the
// user's state directory: url, pid, version, and the private password, with
// 0600 permissions. That file is the complete discovery contract — reading it
// is all a client needs to connect. The daemon's own configuration (port,
// persisted password) is CLI-owned and never read here.

export type Transport = {
  readonly url: string
  readonly headers?: RequestInit["headers"]
}

export type Discover = () => Promise<Transport | undefined>

export function basicAuth(password: string): RequestInit["headers"] {
  return { authorization: "Basic " + btoa("opencode:" + password) }
}

export type Registration = {
  readonly id?: string
  readonly version?: string
  readonly url: string
  readonly pid: number
  readonly password?: string
}

export type LocalService = {
  readonly registration: Registration
  readonly transport: Transport
}

export type ServiceOptions = {
  // Absolute path to the service registration file. Defaults to
  // opencode/service.json in the XDG state directory.
  readonly file?: string
  // When set, discovery only returns a server reporting this exact version,
  // and start() replaces a healthy server whose version differs.
  readonly version?: string
  // Argv used to spawn the service. Defaults to ["opencode", "serve",
  // "--service"] resolved from PATH.
  readonly command?: ReadonlyArray<string>
  readonly timeout?: number
}

export function defaultRegistrationFile(): string {
  const state = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state")
  return join(state, "opencode", "service.json")
}

export async function readRegistration(file?: string): Promise<Registration | undefined> {
  const text = await readFile(file ?? defaultRegistrationFile(), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.url !== "string") return undefined
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return undefined
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    version: typeof record.version === "string" ? record.version : undefined,
    url: record.url,
    pid: record.pid,
    password: typeof record.password === "string" ? record.password : undefined,
  }
}

// Read-only lookup: registration file plus health check and version gate.
// Never spawns; escalation to start() is the caller's policy.
export async function discover(options: ServiceOptions = {}): Promise<LocalService | undefined> {
  const registration = await readRegistration(options.file).catch(() => undefined)
  if (registration === undefined) return undefined
  if (options.version !== undefined && registration.version !== options.version) return undefined
  return await probe(registration, options)
}

async function probe(registration: Registration, options: ServiceOptions): Promise<LocalService | undefined> {
  const headers = registration.password === undefined ? undefined : basicAuth(registration.password)
  const healthy = await fetch(new URL("/api/health", registration.url), {
    headers,
    signal: AbortSignal.timeout(options.timeout ?? 2_000),
  })
    .then((response) => response.ok)
    .catch(() => false)
  if (!healthy) return undefined
  return { registration, transport: { url: registration.url, headers } }
}

// Health-checked lookup without the version gate: lifecycle operations must be
// able to see (and replace or stop) a server from a different version.
async function anyService(options: ServiceOptions): Promise<LocalService | undefined> {
  const registration = await readRegistration(options.file).catch(() => undefined)
  if (registration === undefined) return undefined
  return await probe(registration, options)
}

function signal(pid: number, name: "SIGTERM" | "SIGKILL" | 0): boolean {
  try {
    process.kill(pid, name)
    return true
  } catch {
    return false
  }
}

async function awaitStopped(pid: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!signal(pid, 0)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !signal(pid, 0)
}

function sameRegistration(left: Registration, right: Registration) {
  return left.id === right.id && left.version === right.version && left.url === right.url && left.pid === right.pid
}

async function stopProcess(info: Registration, options: ServiceOptions): Promise<void> {
  // A stale registration may point at a PID that has since been reused by
  // another process. Only signal the PID after authenticating the server.
  const current = await anyService(options)
  if (current === undefined || !sameRegistration(current.registration, info)) return

  signal(info.pid, "SIGTERM")
  if (await awaitStopped(info.pid, 5_000)) return

  const latest = await anyService(options)
  if (latest === undefined || !sameRegistration(latest.registration, info)) return
  signal(info.pid, "SIGKILL")
  await awaitStopped(info.pid, 5_000)
}

export async function stop(options: ServiceOptions = {}): Promise<void> {
  const existing = await anyService(options)
  if (existing !== undefined) await stopProcess(existing.registration, options)
  await rm(options.file ?? defaultRegistrationFile(), { force: true }).catch(() => undefined)
}

// Idempotent ensure-running: reuses a healthy compatible server, replaces a
// version-mismatched one, and otherwise spawns the service command detached.
export async function start(options: ServiceOptions = {}): Promise<Transport> {
  const compatible = await discover(options)
  if (compatible !== undefined) return compatible.transport
  const mismatched = await anyService(options)
  if (mismatched !== undefined) await stopProcess(mismatched.registration, options).catch(() => undefined)

  const [command, ...args] = options.command ?? ["opencode", "serve", "--service"]
  if (command === undefined) throw new Error("Missing service command")
  spawn(command, args, { detached: true, stdio: "ignore" }).unref()

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const found = await discover(options)
    if (found !== undefined) return found.transport
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Failed to start server")
}

// Default connection policy for the local service: discover, else start.
export async function connect(options: ServiceOptions = {}): Promise<Transport> {
  const found = await discover(options)
  if (found !== undefined) return found.transport
  return await start(options)
}
