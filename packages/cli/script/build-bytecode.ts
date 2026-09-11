export const bytecodeOptions = { bytecode: true } as const

export function bytecodeReleaseNeedsProbe(release: string, target: { os: string; arch: string }) {
  if (target.os === process.platform && target.arch === process.arch) return true
  // Foreign executables cannot be probed on the build host; require the exact official release instead.
  const expected = `bun-v${process.versions.bun}`
  if (release !== expected) {
    throw new Error(`Foreign bytecode runtime requires release ${expected}; received ${release}`)
  }
  return false
}

export function bunRuntimeInfo(executable: string) {
  const probe = (flag: string) => {
    const result = Bun.spawnSync([executable, flag], {
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const value = result.stdout.toString().trim()
    if (result.exitCode !== 0 || !value) {
      throw new Error(`Unable to probe Bun runtime ${executable} ${flag}: ${result.stderr.toString()}`)
    }
    return value
  }
  return { version: probe("--version"), revision: probe("--revision") }
}

export function verifyBytecodeRuntime(executable: string, compiler = bunRuntimeInfo(process.execPath)) {
  const runtime = bunRuntimeInfo(executable)
  // JSC bytecode is tied to the compiler revision, not just the release version.
  if (runtime.version !== compiler.version || runtime.revision !== compiler.revision) {
    throw new Error(
      `Bytecode runtime mismatch: ${executable} is ${runtime.version} (${runtime.revision}); compiler requires ${compiler.version} (${compiler.revision})`,
    )
  }
  return runtime
}
