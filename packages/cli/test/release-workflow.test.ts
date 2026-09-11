import { describe, expect, test } from "bun:test"
import path from "node:path"
import { RELEASE_BUN_VERSION, RELEASE_TAG, RELEASE_VERSION } from "../script/release-contract"

const root = path.resolve(import.meta.dir, "../../..")
const workflowPath = path.join(root, ".github", "workflows", "release-cli.yml")
const source = await Bun.file(workflowPath).text()
const workflow = Bun.YAML.parse(source) as Record<string, any>

const expectedMatrix = [
  ["windows-2025", "opencode2-windows-x64", "cli-windows-x64", "opencode2-windows-x64.zip"],
  ["windows-11-arm", "opencode2-windows-arm64", "cli-windows-arm64", "opencode2-windows-arm64.zip"],
  ["ubuntu-24.04", "opencode2-linux-x64", "cli-linux-x64", "opencode2-linux-x64.tar.gz"],
  ["ubuntu-24.04-arm", "opencode2-linux-arm64", "cli-linux-arm64", "opencode2-linux-arm64.tar.gz"],
  ["macos-15-intel", "opencode2-darwin-x64", "cli-darwin-x64", "opencode2-darwin-x64.tar.gz"],
  ["macos-15", "opencode2-darwin-arm64", "cli-darwin-arm64", "opencode2-darwin-arm64.tar.gz"],
]

describe("fork CLI release workflow", () => {
  test("has only the exact manual selected-release trigger", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["version"])
    expect(workflow.on.workflow_dispatch.inputs.version).toMatchObject({
      required: true,
      type: "string",
      default: RELEASE_VERSION,
    })
    expect(workflow.jobs.release.env.RELEASE_TAG).toBe(RELEASE_TAG)
  })

  test("defines the exact six native runner/target/archive combinations", () => {
    const include = workflow.jobs.build.strategy.matrix.include
    expect(include).toHaveLength(6)
    expect(include.map((item: any) => [item.runner, item.target, item.dist, item.archive])).toEqual(expectedMatrix)
    expect(workflow.jobs.build.strategy["fail-fast"]).toBeFalse()
    expect(workflow.jobs.build["runs-on"]).toBe("${{ matrix.runner }}")
  })

  test("pins every action and grants write authority only to final fan-in", () => {
    const uses = Object.values(workflow.jobs)
      .flatMap((job: any) => job.steps)
      .flatMap((step: any) => (step.uses ? [step.uses] : []))
    expect(new Set(uses)).toEqual(
      new Set([
        "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
        "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
        "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
        "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      ]),
    )
    expect(workflow.permissions).toEqual({ contents: "read" })
    expect(workflow.jobs.build.permissions).toBeUndefined()
    expect(workflow.jobs.release.permissions).toEqual({ contents: "write" })
  })

  test("enables Windows symlinks before checkout and verifies source before and after build", () => {
    const steps = workflow.jobs.build.steps as Array<Record<string, unknown>>
    const symlinks = steps.findIndex((step) => step.name === "Enable native symlink checkout on Windows")
    const checkout = steps.findIndex(
      (step) => step.uses === "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
    )
    expect(symlinks).toBeGreaterThanOrEqual(0)
    expect(symlinks).toBeLessThan(checkout)
    expect(steps[symlinks]).toMatchObject({
      if: "runner.os == 'Windows'",
      run: "git config --global core.symlinks true",
      shell: "pwsh",
    })

    const sourceChecks = steps.flatMap((step, index) =>
      typeof step.run === "string" && step.run.includes("packages/cli/script/release-source-check.ts") ? [index] : [],
    )
    const install = steps.findIndex((step) => typeof step.run === "string" && step.run.includes("bun install"))
    const build = steps.findIndex(
      (step) => typeof step.run === "string" && step.run.includes("packages/cli/script/build.ts"),
    )
    expect(sourceChecks).toHaveLength(2)
    expect(sourceChecks[0]).toBeLessThan(install)
    expect(sourceChecks[0]).toBeLessThan(build)
    expect(sourceChecks[1]).toBeGreaterThan(build)
  })

  test("fans in only after every matrix child succeeds and has no partial publication branch", () => {
    expect(workflow.jobs.release.needs).toEqual(["build"])
    expect(workflow.jobs.release.if).toBeUndefined()
    expect(source).not.toContain("always()")
    expect(source).toContain("pattern: release-*")
    expect(source).toContain("--draft")
    expect(source).toContain('gh release edit "$RELEASE_TAG" --draft=false --prerelease')
    expect(source).toContain("trap cleanup_failed_release ERR")
    expect(source).toContain("refusing to clobber it")
  })

  test("keeps build, smoke, integrity, and release identity gates explicit", () => {
    const runtimes = Object.values(workflow.jobs)
      .flatMap((job: any) => job.steps)
      .filter((step: any) => step.uses?.startsWith("oven-sh/setup-bun@"))
    expect(runtimes).toHaveLength(2)
    expect(runtimes.every((step: any) => step.with["bun-version"] === RELEASE_BUN_VERSION)).toBeTrue()
    expect(source).toContain("--frozen-lockfile")
    expect(source).toContain("--single")
    expect(source).toContain("--skip-install")
    expect(source).not.toContain("--skip-web-ui")
    expect(source).toContain("OPENCODE_CHANNEL: zh-cn")
    expect(source).toContain("packages/cli/script/service-smoke.ts")
    expect(source).toContain("packages/cli/script/verify-artifact.ts")
    expect(source).toContain("packages/cli/script/release-source-check.ts")
    expect(source).toContain("packages/cli/script/release-manifest.ts")
    expect(source).toContain('--version="$RELEASE_VERSION"')
    expect(source.match(/--repository=\"\$GITHUB_REPOSITORY\"/g)).toHaveLength(2)
    expect(source.match(/--ref=\"\$GITHUB_REF\"/g)).toHaveLength(2)
    expect(source).toContain("retention-days: 1")
    expect(source).not.toMatch(/retention-days:\s*(?!1(?:\s|$))\d+/)
    expect(
      Object.values(workflow.jobs.build.env).some((value) => String(value).includes("${{ runner.temp }}")),
    ).toBeFalse()
    expect(
      Object.values(workflow.jobs.release.env).some((value) => String(value).includes("${{ runner.temp }}")),
    ).toBeFalse()
    expect(source).toContain('--output="$RUNNER_TEMP/release"')
    expect(source).toContain('--artifacts="$RUNNER_TEMP/release-downloads"')
    expect(source).toContain('--output="$RUNNER_TEMP/release-assets"')
    expect(source).toContain('"$RUNNER_TEMP/release-assets"/*')
    expect(source).toContain("$reported = (& $executable --version | Out-String).Trim()")
    expect(source).toContain('$reported -ne "opencode2 v$env:RELEASE_VERSION"')
    expect(source).toContain('if [ "$reported" != "opencode2 v$RELEASE_VERSION" ]; then')
    expect(source).toContain('$env:BUN_BE_BUN = "1"')
    expect(source).toContain("$embeddedRevision -ne $compilerRevision")
    expect(source).toContain('embedded_revision="$(BUN_BE_BUN=1 "$executable" --revision)"')
    expect(source).toContain('if [ "$embedded_revision" != "$compiler_revision" ]; then')
    expect(source).not.toContain("$reported.Contains(")
    expect(source).not.toContain('case "$reported" in')
  })

  test("contains no forbidden trigger, authority, credential, cache, or unrelated publisher", () => {
    for (const forbidden of [
      "pull_request_target",
      "workflow_call",
      "repository_dispatch",
      "id-token:",
      "packages:",
      "attestations:",
      "actions/cache",
      "publish.yml",
      "script/publish",
      "script/version",
      "script/update",
      "update.opencode.ai",
      "secrets.",
      "packages/desktop",
      "npm publish",
      "docker",
      "cosign",
      "sigstore",
      "vscode",
    ]) {
      expect(source).not.toContain(forbidden)
    }
    expect(source).not.toMatch(/^\s+(?:push|pull_request|schedule):/m)
  })
})
