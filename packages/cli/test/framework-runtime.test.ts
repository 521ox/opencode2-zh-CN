import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode-ai/util/global"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Option } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CpuProfile } from "../src/cpu-profile"
import { withCpuProfile, resolveCpuProfileTarget } from "../src/framework/runtime"
import { ServiceConfig } from "../src/services/service-config"

describe("resolveCpuProfileTarget", () => {
  test("prefers the explicit global flag", () => {
    expect(resolveCpuProfileTarget("serve", Option.some("explicit.cpuprofile"), "inherited.cpuprofile")).toBe(
      "explicit.cpuprofile",
    )
  })

  test("uses the marked inherited profile for a private serve process", () => {
    const inherited = CpuProfile.inheritedTarget("inherited.cpuprofile", CpuProfile.explicitSource)
    expect(resolveCpuProfileTarget("serve", Option.none(), inherited)).toBe("inherited.cpuprofile")
  })

  test("ignores the inherited profile for non-serve commands", () => {
    const inherited = CpuProfile.inheritedTarget("inherited.cpuprofile", CpuProfile.explicitSource)
    expect(resolveCpuProfileTarget("opencode", Option.none(), inherited)).toBeUndefined()
  })

  test("rejects an unmarked ambient profile", () => {
    expect(CpuProfile.inheritedTarget("ambient.cpuprofile", undefined)).toBeUndefined()
  })

  test("clears marked inherited profiles from non-serve handlers and restores them after success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runtime-profile-scope-"))
    const inherited = path.join(root, "inherited.cpuprofile")
    try {
      await withProfileEnvironment(inherited, CpuProfile.explicitSource, async () => {
        let command: ReadonlyArray<string> | undefined
        await Effect.runPromise(
          withCpuProfile(
            "service",
            Option.none(),
            Effect.gen(function* () {
              expect(process.env[CpuProfile.targetEnvironment]).toBeUndefined()
              expect(process.env[CpuProfile.sourceEnvironment]).toBeUndefined()
              command = (yield* ServiceConfig.options()).command
            }),
          ).pipe(
            Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
            Effect.provide(NodeFileSystem.layer),
          ),
        )
        if (command === undefined) throw new Error("Non-serve handler did not reach ServiceConfig")
        expect(command).not.toContain("--cpu-profile")
        expect(command).not.toContain(inherited)
        expect(process.env[CpuProfile.targetEnvironment]).toBe(inherited)
        expect(process.env[CpuProfile.sourceEnvironment]).toBe(CpuProfile.explicitSource)
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("keeps an explicit non-serve profile available for managed service spawning", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runtime-profile-explicit-"))
    const profile = path.join(root, "explicit.cpuprofile")
    try {
      await withProfileEnvironment("caller.cpuprofile", "caller-source", async () => {
        let command: ReadonlyArray<string> | undefined
        await Effect.runPromise(
          withCpuProfile(
            "service",
            Option.some(profile),
            Effect.gen(function* () {
              expect(process.env[CpuProfile.targetEnvironment]).toBe(path.resolve(profile))
              expect(process.env[CpuProfile.sourceEnvironment]).toBe(CpuProfile.explicitSource)
              command = (yield* ServiceConfig.options()).command
            }),
          ).pipe(
            Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
            Effect.provide(NodeFileSystem.layer),
          ),
        )
        if (command === undefined) throw new Error("Non-serve handler did not reach ServiceConfig")
        expect(command.slice(-2)).toEqual(["--cpu-profile", path.resolve(profile)])
        expect(process.env[CpuProfile.targetEnvironment]).toBe("caller.cpuprofile")
        expect(process.env[CpuProfile.sourceEnvironment]).toBe("caller-source")
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("restores non-serve profile variables after failure and interruption", async () => {
    const inherited = "inherited.cpuprofile"
    await withProfileEnvironment(inherited, CpuProfile.explicitSource, async () => {
      const failure = await Effect.runPromise(
        withCpuProfile(
          "run",
          Option.none(),
          Effect.sync(() => {
            expect(process.env[CpuProfile.targetEnvironment]).toBeUndefined()
            expect(process.env[CpuProfile.sourceEnvironment]).toBeUndefined()
          }).pipe(Effect.andThen(Effect.fail(new Error("expected handler failure")))),
        ).pipe(Effect.provide(NodeFileSystem.layer)),
      ).then(
        () => undefined,
        (error) => error,
      )
      if (!(failure instanceof Error)) throw new Error("Expected handler failure")
      expect(failure.message).toContain("expected handler failure")
      expect(process.env[CpuProfile.targetEnvironment]).toBe(inherited)
      expect(process.env[CpuProfile.sourceEnvironment]).toBe(CpuProfile.explicitSource)

      let resolveStarted!: () => void
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
      const fiber = Effect.runFork(
        withCpuProfile(
          "run",
          Option.none(),
          Effect.sync(() => {
            expect(process.env[CpuProfile.targetEnvironment]).toBeUndefined()
            expect(process.env[CpuProfile.sourceEnvironment]).toBeUndefined()
            resolveStarted()
          }).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.provide(NodeFileSystem.layer)),
      )
      try {
        await started
        await Effect.runPromise(Fiber.interrupt(fiber))
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
      expect(process.env[CpuProfile.targetEnvironment]).toBe(inherited)
      expect(process.env[CpuProfile.sourceEnvironment]).toBe(CpuProfile.explicitSource)
    })
  })
})

async function withProfileEnvironment(
  target: string | undefined,
  source: string | undefined,
  run: () => Promise<void>,
) {
  const previousTarget = process.env[CpuProfile.targetEnvironment]
  const previousSource = process.env[CpuProfile.sourceEnvironment]
  if (target === undefined) delete process.env[CpuProfile.targetEnvironment]
  else process.env[CpuProfile.targetEnvironment] = target
  if (source === undefined) delete process.env[CpuProfile.sourceEnvironment]
  else process.env[CpuProfile.sourceEnvironment] = source
  try {
    await run()
  } finally {
    if (previousTarget === undefined) delete process.env[CpuProfile.targetEnvironment]
    else process.env[CpuProfile.targetEnvironment] = previousTarget
    if (previousSource === undefined) delete process.env[CpuProfile.sourceEnvironment]
    else process.env[CpuProfile.sourceEnvironment] = previousSource
  }
}
