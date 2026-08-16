param(
  [string] $PublishDirectory = "D:\opencode2-zh-CN-nightly-windows-x64",
  [switch] $SkipInstall,
  [switch] $SkipWebUI,
  [switch] $Baseline,
  [switch] $RunServiceSmoke,
  [ValidateSet("PinnedCanary", "Current", "MovingCanary")]
  [string] $CompileRuntime = "PinnedCanary",
  [string] $CompileRuntimeCache = "$env:LOCALAPPDATA\opencode-build\bun"
)

$ErrorActionPreference = "Stop"

function Restore-EnvironmentVariable {
  param(
    [string] $Name,
    [AllowNull()]
    [string] $Value
  )

  if ($null -eq $Value) {
    Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    return
  }
  Set-Item -LiteralPath "Env:$Name" -Value $Value
}

function Get-BunRuntimeInfo {
  param(
    [string] $Path,
    [AllowNull()]
    [string] $ExpectedSHA256,
    [AllowNull()]
    [string] $ExpectedVersion,
    [AllowNull()]
    [string] $ExpectedRevision
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Bun compile runtime not found: $Path"
  }

  $sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($ExpectedSHA256 -and $sha256 -ne $ExpectedSHA256.ToLowerInvariant()) {
    throw "Bun compile runtime hash mismatch: actual=$sha256 expected=$ExpectedSHA256"
  }

  $version = ((& $Path --version) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read Bun compile runtime version: $Path"
  }
  if ($ExpectedVersion -and $version -ne $ExpectedVersion) {
    throw "Bun compile runtime version mismatch: actual=$version expected=$ExpectedVersion"
  }

  $revision = ((& $Path --revision) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read Bun compile runtime revision: $Path"
  }
  if ($ExpectedRevision -and $revision -ne $ExpectedRevision) {
    throw "Bun compile runtime revision mismatch: actual=$revision expected=$ExpectedRevision"
  }

  [pscustomobject]@{
    Path = $Path
    SHA256 = $sha256
    Version = $version
    Revision = $revision
    AssetId = $null
    AssetName = $null
    ZipSHA256 = $null
    CacheHit = $null
  }
}

function Get-PinnedBunRuntimeSpec {
  param([bool] $IsBaseline)

  if ($IsBaseline) {
    return [pscustomobject]@{
      AssetId = 516562416
      AssetName = "bun-windows-x64-baseline.zip"
      ZipSHA256 = "c0dede7c9e546335e01b6390f66d8a97f7a1fc454d96ed2e05aeca0d45dc550c"
      DirectoryName = "bun-windows-x64-baseline"
    }
  }

  [pscustomobject]@{
    AssetId = 516562299
    AssetName = "bun-windows-x64.zip"
    ZipSHA256 = "aebf834d6532e68bbe6a4ca6b918e0c76e963d2ae37ffb17aacb4f555f3b03e4"
    DirectoryName = "bun-windows-x64"
  }
}

function Get-PinnedBunRuntime {
  param(
    [bool] $IsBaseline,
    [string] $CacheRoot
  )

  $expectedVersion = "1.4.0"
  $expectedRevision = "1.4.0-canary.1+aec33f581"
  $expectedExecutableSHA256 = "11ac1246f004de55fdeab3cb4b91385151357ce96dc69f1dfdc598b6dd7c3b74"
  $spec = Get-PinnedBunRuntimeSpec -IsBaseline $IsBaseline
  $snapshot = "1.4.0-canary.1-aec33f581"
  $cacheDirectory = Join-Path $CacheRoot (Join-Path $snapshot $spec.DirectoryName)
  $cachedExecutable = Join-Path $cacheDirectory "bun.exe"

  if (Test-Path -LiteralPath $cachedExecutable) {
    $runtimeArgs = @{
      Path = $cachedExecutable
      ExpectedSHA256 = $expectedExecutableSHA256
      ExpectedVersion = $expectedVersion
      ExpectedRevision = $expectedRevision
    }
    $runtime = Get-BunRuntimeInfo @runtimeArgs
    $runtime.AssetId = $spec.AssetId
    $runtime.AssetName = $spec.AssetName
    $runtime.ZipSHA256 = $spec.ZipSHA256
    $runtime.CacheHit = $true
    return $runtime
  }

  $staging = Join-Path $CacheRoot (".staging-{0}" -f [guid]::NewGuid().ToString("N"))
  $zip = Join-Path $staging $spec.AssetName
  $expanded = Join-Path $staging "expanded"
  try {
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $downloadArgs = @{
      Headers = @{ Accept = "application/octet-stream"; "User-Agent" = "opencode-v2-custom" }
      Uri = "https://api.github.com/repos/oven-sh/bun/releases/assets/{0}" -f $spec.AssetId
      OutFile = $zip
    }
    Invoke-WebRequest @downloadArgs

    $zipSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    if ($zipSHA256 -ne $spec.ZipSHA256) {
      throw "Pinned Bun archive hash mismatch: actual=$zipSHA256 expected=$($spec.ZipSHA256)"
    }

    Expand-Archive -LiteralPath $zip -DestinationPath $expanded -Force
    $sourceExecutable = Join-Path $expanded (Join-Path $spec.DirectoryName "bun.exe")
    $runtimeArgs = @{
      Path = $sourceExecutable
      ExpectedSHA256 = $expectedExecutableSHA256
      ExpectedVersion = $expectedVersion
      ExpectedRevision = $expectedRevision
    }
    $runtime = Get-BunRuntimeInfo @runtimeArgs

    if (Test-Path -LiteralPath $cacheDirectory) {
      Remove-Item -LiteralPath $cacheDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $cacheDirectory | Out-Null
    Copy-Item -LiteralPath $sourceExecutable -Destination $cachedExecutable
    Copy-Item -LiteralPath $zip -Destination (Join-Path $cacheDirectory $spec.AssetName)
    [pscustomobject]@{
      Version = $runtime.Version
      Revision = $runtime.Revision
      ExecutableSHA256 = $runtime.SHA256
      AssetId = $spec.AssetId
      AssetName = $spec.AssetName
      ZipSHA256 = $spec.ZipSHA256
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $cacheDirectory "snapshot.json") -Encoding utf8
  }
  finally {
    if (Test-Path -LiteralPath $staging) {
      Remove-Item -LiteralPath $staging -Recurse -Force
    }
  }

  $verifiedArgs = @{
    Path = $cachedExecutable
    ExpectedSHA256 = $expectedExecutableSHA256
    ExpectedVersion = $expectedVersion
    ExpectedRevision = $expectedRevision
  }
  $verified = Get-BunRuntimeInfo @verifiedArgs
  $verified.AssetId = $spec.AssetId
  $verified.AssetName = $spec.AssetName
  $verified.ZipSHA256 = $spec.ZipSHA256
  $verified.CacheHit = $false
  $verified
}

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
$previousCompileRelease = $env:BUN_COMPILE_RELEASE
$previousCompileExecutable = $env:BUN_COMPILE_EXECUTABLE
$previousCompileTarget = $env:BUN_COMPILE_EXECUTABLE_TARGET
$previousCompileSHA256 = $env:BUN_COMPILE_EXECUTABLE_SHA256

$compileTarget = if ($Baseline) { "opencode2-windows-x64-baseline" } else { "opencode2-windows-x64" }
$compileRuntimeInfo = $null

switch ($CompileRuntime) {
  "PinnedCanary" {
    $compileRuntimeInfo = Get-PinnedBunRuntime -IsBaseline ([bool] $Baseline) -CacheRoot $CompileRuntimeCache
    Remove-Item -LiteralPath "Env:BUN_COMPILE_RELEASE" -ErrorAction SilentlyContinue
    $env:BUN_COMPILE_EXECUTABLE = $compileRuntimeInfo.Path
    $env:BUN_COMPILE_EXECUTABLE_TARGET = $compileTarget
    $env:BUN_COMPILE_EXECUTABLE_SHA256 = $compileRuntimeInfo.SHA256
  }
  "Current" {
    Remove-Item -LiteralPath "Env:BUN_COMPILE_RELEASE" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Env:BUN_COMPILE_EXECUTABLE" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Env:BUN_COMPILE_EXECUTABLE_TARGET" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Env:BUN_COMPILE_EXECUTABLE_SHA256" -ErrorAction SilentlyContinue
    $compileRuntimeInfo = Get-BunRuntimeInfo -Path $bun
  }
  "MovingCanary" {
    $env:BUN_COMPILE_RELEASE = "canary"
    Remove-Item -LiteralPath "Env:BUN_COMPILE_EXECUTABLE" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Env:BUN_COMPILE_EXECUTABLE_TARGET" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Env:BUN_COMPILE_EXECUTABLE_SHA256" -ErrorAction SilentlyContinue
  }
}

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

  if ($CompileRuntime -eq "MovingCanary") {
    $runtimeDirectory = if ($Baseline) { "bun-windows-x64-baseline" } else { "bun-windows-x64" }
    $movingRuntime = Join-Path $repoRoot ("packages\cli\dist\.bun\canary\{0}\bun.exe" -f $runtimeDirectory)
    $compileRuntimeInfo = Get-BunRuntimeInfo -Path $movingRuntime
  }

  $expectedVersion = "opencode2 v$version"
  $builtVersion = ((& $builtExe --version) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $builtVersion -ne $expectedVersion) {
    throw "Build version mismatch: actual=$builtVersion expected=$expectedVersion"
  }

  if ($RunServiceSmoke) {
    & $bun run --cwd packages/cli script/service-smoke.ts ("--target={0}" -f $target)
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

  $sourceCommit = (git rev-parse HEAD).Trim()
  $sourceDirty = -not [string]::IsNullOrWhiteSpace((git status --porcelain | Out-String))
  $metadata = [ordered]@{
    Version = $version
    SourceCommit = $sourceCommit
    SourceDirty = $sourceDirty
    BuildBunVersion = $actualBun
    CompileRuntimeMode = $CompileRuntime
    CompileRuntimeVersion = $compileRuntimeInfo.Version
    CompileRuntimeRevision = $compileRuntimeInfo.Revision
    CompileRuntimePath = $compileRuntimeInfo.Path
    CompileRuntimeSHA256 = $compileRuntimeInfo.SHA256
    CompileRuntimeAssetId = $compileRuntimeInfo.AssetId
    CompileRuntimeAssetName = $compileRuntimeInfo.AssetName
    CompileRuntimeZipSHA256 = $compileRuntimeInfo.ZipSHA256
    CompileRuntimeCacheHit = $compileRuntimeInfo.CacheHit
    Candidate = $timestampedExe
    CandidateLength = (Get-Item -LiteralPath $timestampedExe).Length
    CandidateSHA256 = $timestampedHash
    WebUI = -not $SkipWebUI
    Baseline = [bool] $Baseline
    ServiceSmoke = [bool] $RunServiceSmoke
  }
  $rootMetadata = "$rootExe.build.json"
  $timestampedMetadata = "$timestampedExe.build.json"
  $metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $rootMetadata -Encoding utf8
  $metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $timestampedMetadata -Encoding utf8

  [pscustomobject]@{
    Version = $version
    Bun = $actualBun
    CompileRuntimeMode = $CompileRuntime
    CompileRuntimeVersion = $compileRuntimeInfo.Version
    CompileRuntimeRevision = $compileRuntimeInfo.Revision
    CompileRuntimePath = $compileRuntimeInfo.Path
    CompileRuntimeSHA256 = $compileRuntimeInfo.SHA256
    CompileRuntimeAssetId = $compileRuntimeInfo.AssetId
    CompileRuntimeCacheHit = $compileRuntimeInfo.CacheHit
    Source = $builtExe
    Worktree = $rootExe
    Timestamped = $timestampedExe
    Metadata = $timestampedMetadata
    Length = (Get-Item -LiteralPath $rootExe).Length
    SHA256 = $builtHash
    WebUI = -not $SkipWebUI
    Baseline = [bool] $Baseline
    ServiceSmoke = [bool] $RunServiceSmoke
  } | Format-List
}
finally {
  Restore-EnvironmentVariable -Name "OPENCODE_CHANNEL" -Value $previousChannel
  Restore-EnvironmentVariable -Name "OPENCODE_VERSION" -Value $previousVersion
  Restore-EnvironmentVariable -Name "BUN_COMPILE_RELEASE" -Value $previousCompileRelease
  Restore-EnvironmentVariable -Name "BUN_COMPILE_EXECUTABLE" -Value $previousCompileExecutable
  Restore-EnvironmentVariable -Name "BUN_COMPILE_EXECUTABLE_TARGET" -Value $previousCompileTarget
  Restore-EnvironmentVariable -Name "BUN_COMPILE_EXECUTABLE_SHA256" -Value $previousCompileSHA256
  Pop-Location
}
