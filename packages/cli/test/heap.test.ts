import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Heap } from "../src/heap"

type Listener = (event: string, file: string | Buffer | null) => void

async function withWindowsListener(
  run: (input: {
    readonly directory: string
    readonly emit: (event: string, file: string) => void
    readonly closeCount: () => number
  }) => Promise<void>,
  capture: (file: string) => Promise<void>,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-heap-"))
  let listener: Listener | undefined
  let closed = 0
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Heap.listenWith({
            directory,
            enabled: true,
            platform: "win32",
            pid: 123,
            now: () => new Date("2026-08-29T00:00:00.000Z"),
            delay: 0,
            capture,
            watch(_directory, callback) {
              listener = callback
              return { close: () => closed++ }
            },
          })
          yield* Effect.promise(() =>
            run({
              directory,
              emit(event, file) {
                listener?.(event, file)
              },
              closeCount: () => closed,
            }),
          )
        }),
      ),
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test("heap trigger only enables for an inherited value of 1", () => {
  expect(Heap.isTriggerEnabled({})).toBe(false)
  expect(Heap.isTriggerEnabled({ OPENCODE_HEAP_TRIGGER: "" })).toBe(false)
  expect(Heap.isTriggerEnabled({ OPENCODE_HEAP_TRIGGER: "0" })).toBe(false)
  expect(Heap.isTriggerEnabled({ OPENCODE_HEAP_TRIGGER: "true" })).toBe(false)
  expect(Heap.isTriggerEnabled({ OPENCODE_HEAP_TRIGGER: " 1" })).toBe(false)
  expect(Heap.isTriggerEnabled({ OPENCODE_HEAP_TRIGGER: "1 " })).toBe(false)

  const tuiEnvironment = { OPENCODE_HEAP_TRIGGER: "1" }
  const serveEnvironment = { ...tuiEnvironment }
  expect(Heap.isTriggerEnabled(serveEnvironment)).toBe(true)
})

test("disabled heap trigger leaves old markers untouched and installs no listeners", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-heap-disabled-"))
  const marker = path.join(directory, "heap-123.trigger")
  let markerReads = 0
  let markerRemovals = 0
  let watcherStarts = 0
  const signals = process.listenerCount("SIGUSR1")
  await fs.writeFile(marker, "")
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Heap.listenWith({
            directory,
            enabled: false,
            platform: "win32",
            pid: 123,
            marker: async () => {
              markerReads += 1
              return undefined
            },
            remove: async () => {
              markerRemovals += 1
            },
            watch() {
              watcherStarts += 1
              return { close() {} }
            },
          })
          yield* Heap.listenWith({ directory, enabled: false, platform: "linux" })
        }),
      ),
    )
    await expect(fs.access(marker)).resolves.toBeNull()
    expect(markerReads).toBe(0)
    expect(markerRemovals).toBe(0)
    expect(watcherStarts).toBe(0)
    expect(process.listenerCount("SIGUSR1")).toBe(signals)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("Windows listener captures only its PID marker and consumes it", async () => {
  let resolveCapture!: () => void
  const captured = new Promise<void>((resolve) => {
    resolveCapture = resolve
  })
  const files: string[] = []
  await withWindowsListener(
    async ({ directory, emit, closeCount }) => {
      emit("rename", "heap-123.trigger")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(files).toEqual([])
      await fs.writeFile(path.join(directory, "heap-456.trigger"), "")
      emit("rename", "heap-456.trigger")
      emit("change", "heap-123.trigger")
      await fs.writeFile(path.join(directory, "heap-123.trigger"), "")
      emit("rename", "heap-123.trigger")
      await captured
      expect(files).toEqual([path.join(directory, "heap-123-2026-08-29T000000000Z.heapsnapshot")])
      await expect(fs.access(path.join(directory, "heap-123.trigger"))).rejects.toThrow()
      expect(closeCount()).toBe(0)
    },
    async (file) => {
      files.push(file)
      resolveCapture()
    },
  )
})

test("Windows listener coalesces duplicate triggers while one capture is active", async () => {
  let active = 0
  let maximum = 0
  let resolveFirst!: () => void
  let resolveSecond!: () => void
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve
  })
  const second = new Promise<void>((resolve) => {
    resolveSecond = resolve
  })
  let started!: () => void
  const startedCapture = new Promise<void>((resolve) => {
    started = resolve
  })
  let count = 0
  await withWindowsListener(
    async ({ directory, emit }) => {
      const marker = path.join(directory, "heap-123.trigger")
      const failedMarker = path.join(directory, "heap-123.failed")
      await fs.writeFile(marker, "")
      emit("rename", "heap-123.trigger")
      await startedCapture
      await fs.writeFile(marker, "")
      emit("rename", "heap-123.trigger")
      emit("rename", "heap-123.trigger")
      resolveFirst()
      await second
      expect(count).toBe(2)
      expect(maximum).toBe(1)
    },
    async () => {
      count += 1
      active += 1
      maximum = Math.max(maximum, active)
      if (count === 1) {
        started()
        await first
      }
      if (count === 2) {
        active -= 1
        resolveSecond()
        return
      }
      active -= 1
    },
  )
})

test("Windows listener recovers after a failed capture", async () => {
  let notify!: () => void
  const finished = new Promise<void>((resolve) => {
    notify = resolve
  })
  let count = 0
  await withWindowsListener(
    async ({ directory, emit }) => {
      const marker = path.join(directory, "heap-123.trigger")
      const failedMarker = path.join(directory, "heap-123.failed")
      await fs.writeFile(marker, "")
      emit("rename", "heap-123.trigger")
      while (count < 3) await new Promise((resolve) => setTimeout(resolve, 0))
      await expect(fs.access(failedMarker)).resolves.toBeNull()
      await expect(fs.access(marker)).rejects.toThrow()
      await fs.writeFile(marker, "")
      emit("rename", "heap-123.trigger")
      await finished
      expect(count).toBe(4)
      await expect(fs.access(marker)).rejects.toThrow()
    },
    async () => {
      count += 1
      if (count <= 3) {
        throw new Error("expected capture failure")
      }
      notify()
    },
  )
})

test("Windows listener removes a stale marker and closes its watcher with the scope", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-heap-stale-"))
  const marker = path.join(directory, "heap-123.trigger")
  let closed = 0
  let captures = 0
  await fs.writeFile(marker, "")
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Heap.listenWith({
            directory,
            enabled: true,
            platform: "win32",
            pid: 123,
            now: () => new Date(Date.now() + 1_000),
            delay: 0,
            capture: async () => {
              captures += 1
            },
            watch() {
              return { close: () => closed++ }
            },
          })
          yield* Effect.sleep("1 millis")
        }),
      ),
    )
    await expect(fs.access(marker)).rejects.toThrow()
    expect(captures).toBe(0)
    expect(closed).toBe(1)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("Windows startup survives stale cleanup and consume lock retries", async () => {
  let staleRemovals = 0
  let consumes = 0
  let captures = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Heap.listenWith({
          directory: os.tmpdir(),
          enabled: true,
          platform: "win32",
          pid: 123,
          now: () => new Date(1),
          delay: 0,
          marker: async () => (staleRemovals === 0 ? 0 : 2),
          remove: async () => {
            staleRemovals += 1
            throw Object.assign(new Error("locked"), { code: "EPERM" })
          },
          consume: async () => {
            consumes += 1
            if (consumes < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" })
            return true
          },
          capture: async () => {
            captures += 1
          },
          watch() {
            return { close() {} }
          },
        })
        yield* Effect.sleep("5 millis")
      }),
    ),
  )
  expect(staleRemovals).toBe(4)
  expect(consumes).toBe(3)
  expect(captures).toBe(1)
})

test("Windows null filename event reconciles a marker", async () => {
  let listener: Listener | undefined
  let present = false
  let consumes = 0
  let captured!: () => void
  const done = new Promise<void>((resolve) => {
    captured = resolve
  })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Heap.listenWith({
          directory: os.tmpdir(),
          enabled: true,
          platform: "win32",
          pid: 123,
          now: () => new Date(1),
          delay: 0,
          marker: async () => (present ? 2 : undefined),
          consume: async () => {
            consumes += 1
            if (consumes < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" })
            present = false
            return true
          },
          capture: async () => captured(),
          watch(_directory, callback) {
            listener = callback
            return { close() {} }
          },
        })
        present = true
        listener?.("rename", null)
        yield* Effect.promise(() => done)
      }),
    ),
  )
  expect(consumes).toBe(3)
})

test("Windows reconciles a marker created while subscribing", async () => {
  let present = false
  let captured!: () => void
  const done = new Promise<void>((resolve) => {
    captured = resolve
  })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Heap.listenWith({
          directory: os.tmpdir(),
          enabled: true,
          platform: "win32",
          pid: 123,
          now: () => new Date(1),
          delay: 0,
          marker: async () => (present ? 2 : undefined),
          consume: async () => true,
          capture: async () => captured(),
          watch() {
            present = true
            return { close() {} }
          },
        })
        yield* Effect.promise(() => done)
      }),
    ),
  )
})

test("Windows accepts a marker whose timestamp equals listener start", async () => {
  let captured!: () => void
  const done = new Promise<void>((resolve) => {
    captured = resolve
  })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Heap.listenWith({
          directory: os.tmpdir(),
          enabled: true,
          platform: "win32",
          pid: 123,
          now: () => new Date(1),
          delay: 0,
          marker: async () => 1,
          consume: async () => true,
          capture: async () => captured(),
          watch() {
            return { close() {} }
          },
        })
        yield* Effect.promise(() => done)
      }),
    ),
  )
})

test("Windows shutdown cancels retry delay", async () => {
  let attempted!: () => void
  const started = new Promise<void>((resolve) => {
    attempted = resolve
  })
  let attempts = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Heap.listenWith({
          directory: os.tmpdir(),
          enabled: true,
          platform: "win32",
          pid: 123,
          now: () => new Date(1),
          marker: async () => 2,
          consume: async () => {
            attempts += 1
            attempted()
            throw new Error("locked")
          },
          watch() {
            return { close() {} }
          },
        })
        yield* Effect.promise(() => started)
      }),
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(attempts).toBe(1)
})

test("Unix listener retains SIGUSR1 lifecycle", async () => {
  const listeners = process.listenerCount("SIGUSR1")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Heap.listenWith({ directory: os.tmpdir(), enabled: true, platform: "linux" })
        expect(process.listenerCount("SIGUSR1")).toBe(listeners + 1)
      }),
    ),
  )
  expect(process.listenerCount("SIGUSR1")).toBe(listeners)
})
