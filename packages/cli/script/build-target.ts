export type BuildTarget = {
  readonly os: string
  readonly arch: "arm64" | "x64"
  readonly abi?: "musl"
  readonly avx2?: false
}

export function matchesSingleTarget(item: BuildTarget, platform: string, arch: string, baseline: boolean) {
  if (item.os !== platform || item.arch !== arch || item.abi !== undefined) return false
  if (item.arch !== "x64") return !baseline && item.avx2 !== false
  return baseline ? item.avx2 === false : item.avx2 !== false
}
