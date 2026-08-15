param(
  [string] $PublishDirectory = "D:\opencode2-zh-CN-nightly-windows-x64",
  [switch] $SkipInstall,
  [switch] $SkipWebUI,
  [switch] $Baseline,
  [switch] $RunServiceSmoke
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json
$cliPackage = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "packages\cli\package.json") | ConvertFrom-Json
$requiredBun = $rootPackage.packageManager -replace '^bun@', ''
$version = $cliPackage.version
$bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"

if (-not (Test-Path -LiteralPath $bun)) {
  throw "Bun executable not found: $bun"
}

$actualBun = (& $bun --version).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Unable to read the Bun version"
}
if ($actualBun -ne $requiredBun) {
  throw "Bun version mismatch: actual=$actualBun required=$requiredBun"
}

$previousChannel = $env:OPENCODE_CHANNEL
$previousVersion = $env:OPENCODE_VERSION

Push-Location $repoRoot
try {
  if (-not $SkipInstall) {
    & $bun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
      throw "bun install --frozen-lockfile failed"
    }
  }

  $env:OPENCODE_CHANNEL = "latest"
  $env:OPENCODE_VERSION = $version

  $buildArgs = @(
    "run",
    "--cwd",
    "packages/cli",
    "script/build.ts",
    "--single",
    "--skip-install"
  )
  if ($SkipWebUI) {
    $buildArgs += "--skip-web-ui"
  }
  if ($Baseline) {
    $buildArgs += "--baseline"
  }

  & $bun @buildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "OpenCode V2 build failed"
  }

  $target = if ($Baseline) { "cli-windows-x64-baseline" } else { "cli-windows-x64" }
  $builtExe = Join-Path $repoRoot ("packages\cli\dist\{0}\bin\opencode2.exe" -f $target)
  if (-not (Test-Path -LiteralPath $builtExe)) {
    throw "Build output not found: $builtExe"
  }

  $expectedVersion = "opencode2 v$version"
  $builtVersion = ((& $builtExe --version) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $builtVersion -ne $expectedVersion) {
    throw "Build version mismatch: actual=$builtVersion expected=$expectedVersion"
  }

  if ($RunServiceSmoke) {
    & $bun run --cwd packages/cli script/service-smoke.ts
    if ($LASTEXITCODE -ne 0) {
      throw "Compiled service lifecycle smoke test failed"
    }
  }

  $publishParent = Split-Path -Parent $PublishDirectory
  if (-not (Test-Path -LiteralPath $publishParent)) {
    throw "Publish parent directory not found: $publishParent"
  }
  if (-not (Test-Path -LiteralPath $PublishDirectory)) {
    New-Item -ItemType Directory -Path $PublishDirectory | Out-Null
  }

  $rootExe = Join-Path $repoRoot "opencode2.exe"
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $suffix = if ($Baseline) { "-baseline" } else { "" }
  $timestampedExe = Join-Path $PublishDirectory (
    "opencode2-zh-CN-{0}-windows-x64{1}-{2}.exe" -f $version, $suffix, $timestamp
  )

  Copy-Item -Force -LiteralPath $builtExe -Destination $rootExe
  Copy-Item -Force -LiteralPath $builtExe -Destination $timestampedExe

  $builtHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $builtExe).Hash
  $rootHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $rootExe).Hash
  $timestampedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $timestampedExe).Hash
  if ($builtHash -ne $rootHash -or $builtHash -ne $timestampedHash) {
    throw "Exported binary hash mismatch"
  }

  [pscustomobject]@{
    Version = $version
    Bun = $actualBun
    Source = $builtExe
    Worktree = $rootExe
    Timestamped = $timestampedExe
    Length = (Get-Item -LiteralPath $rootExe).Length
    SHA256 = $builtHash
    WebUI = -not $SkipWebUI
    Baseline = [bool] $Baseline
    ServiceSmoke = [bool] $RunServiceSmoke
  } | Format-List
}
finally {
  $env:OPENCODE_CHANNEL = $previousChannel
  $env:OPENCODE_VERSION = $previousVersion
  Pop-Location
}
