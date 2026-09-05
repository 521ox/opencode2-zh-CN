import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode-ai/util/global"
import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import fs from "node:fs/promises"
import { Session } from "node:inspector"
import os from "node:os"
import path from "node:path"
import { CpuProfile } from "../src/cpu-profile"

test("subscribes and unsubscribes SIGPROF with the CLI scope", async () => {
  const listeners = process.listenerCount("SIGPROF")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* CpuProfile.listen
        expect(process.listenerCount("SIGPROF")).toBe(listeners + (process.platform === "win32" ? 0 : 1))
      }),
    ).pipe(Effect.provideService(Global.Service, Global.make()), Effect.provide(NodeFileSystem.layer)),
  )
  expect(process.listenerCount("SIGPROF")).toBe(listeners)
})

test("ignores an overlapping signal profile while an explicit profile owns the inspector", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-cpu-profile-overlap-"))
  let created = 0
  let startedCount = 0
  let stopped = 0
  let disconnected = 0
  let resolveStarted!: () => void
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const createSession = () => {
    created += 1
    return {
      connect() {},
      disconnect() {
        disconnected += 1
      },
      post(method: string, callback: (error: Error | null, result: { profile: object }) => void) {
        if (method === "Profiler.start") {
          startedCount += 1
          resolveStarted()
        }
        if (method === "Profiler.stop") stopped += 1
        callback(null, { profile: {} })
      },
    } as unknown as Session
  }
  const explicit = Effect.runFork(
    CpuProfile.run(path.join(root, "explicit.cpuprofile"), Effect.never, { createSession }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  )

  try {
    await started
    await Effect.runPromise(
      CpuProfile.run(path.join(root, "signal.cpuprofile"), Effect.void, { source: "signal", createSession }).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(created).toBe(1)
    expect(startedCount).toBe(1)
    expect(stopped).toBe(0)
  } finally {
    await Effect.runPromise(Fiber.interrupt(explicit))
    await fs.rm(root, { recursive: true, force: true })
  }

  expect(stopped).toBe(1)
  expect(disconnected).toBe(1)
})

test("releases profiler ownership after success and failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-cpu-profile-release-"))
  let created = 0
  let stopped = 0
  let disconnected = 0
  const createSession = () => {
    created += 1
    return {
      connect() {},
      disconnect() {
        disconnected += 1
      },
      post(method: string, callback: (error: Error | null, result: { profile: object }) => void) {
        if (method === "Profiler.stop") stopped += 1
        callback(null, { profile: {} })
      },
    } as unknown as Session
  }
  const run = (name: string, effect: Effect.Effect<void, Error | never>) =>
    Effect.runPromise(
      CpuProfile.run(path.join(root, name), effect, { createSession }).pipe(Effect.provide(NodeFileSystem.layer)),
    )

  try {
    await run("success.cpuprofile", Effect.void)
    await expect(run("failure.cpuprofile", Effect.fail(new Error("expected profile failure")))).rejects.toThrow(
      "expected profile failure",
    )
    await Effect.runPromise(
      CpuProfile.run(path.join(root, "signal.cpuprofile"), Effect.void, { source: "signal", createSession }).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }

  expect(created).toBe(3)
  expect(stopped).toBe(3)
  expect(disconnected).toBe(3)
})
