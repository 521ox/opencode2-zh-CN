param(
  [string] $SourceDatabase = "$env:USERPROFILE\.local\share\opencode\opencode.db",
  [string] $CandidateExecutable = "",
  [string] $RehearsalRoot = "D:\opencode2-migration-rehearsal",
  [string] $Bun = "$env:USERPROFILE\.bun\bin\bun.exe",
  [int] $TimeoutMinutes = 180,
  [switch] $AllowMigrationWarnings
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $CandidateExecutable) { $CandidateExecutable = Join-Path $repoRoot "opencode2.exe" }
$cliPackage = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "packages\cli\package.json") | ConvertFrom-Json
$expectedVersion = "opencode2 v$($cliPackage.version)"
$sqliteHelper = Join-Path $PSScriptRoot "v1-to-v2-migration-sqlite.ts"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDirectory = Join-Path $RehearsalRoot ("v1-to-v2-" + $timestamp)
$rawDirectory = Join-Path $runDirectory "raw"
$workDirectory = Join-Path $runDirectory "work"
$isolationDirectory = Join-Path $runDirectory "isolation"
$logPath = Join-Path $runDirectory "rehearsal.log"
$statusPath = Join-Path $runDirectory "status.json"
$completePath = Join-Path $runDirectory "COMPLETE"
$failedPath = Join-Path $runDirectory "FAILED"
$sourceWal = $SourceDatabase + "-wal"
$sourceShm = $SourceDatabase + "-shm"
$databaseName = Split-Path -Leaf $SourceDatabase
$rawDatabase = Join-Path $rawDirectory $databaseName
$workDatabase = Join-Path $workDirectory $databaseName
$sourceGuards = [System.Collections.Generic.List[System.IO.FileStream]]::new()
$server = $null
$stdoutTask = $null
$stderrTask = $null
$failureEvidence = $null

function Write-Log([string] $Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
  Write-Host $line
}

function Write-Status([string] $Stage, [string] $Outcome, [object] $Details = $null) {
  [ordered]@{
    schemaVersion = 1
    recordedAt = (Get-Date).ToString("o")
    stage = $Stage
    outcome = $Outcome
    runDirectory = $runDirectory
    sourceDatabase = $SourceDatabase
    candidateExecutable = $CandidateExecutable
    details = $Details
  } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $statusPath -Encoding utf8
}

function Get-Length([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0L }
  return (Get-Item -LiteralPath $Path).Length
}

function Get-Sha256([string] $Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToUpperInvariant()
}

function Get-FreeBytes([string] $Path) {
  $root = [System.IO.Path]::GetPathRoot($Path)
  return ([System.IO.DriveInfo]::new($root)).AvailableFreeSpace
}

function Get-OpenCodeProcesses {
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "opencode*" })
}

function Assert-NoOpenCode {
  $processes = @(Get-OpenCodeProcesses)
  if ($processes.Count -gt 0) {
    throw "OpenCode processes are still running: $($processes.Id -join ', ')"
  }
}

function Protect-SourceFile([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  $sourceGuards.Add($stream)
}

function Copy-Verified([string] $Source, [string] $Destination) {
  if (-not (Test-Path -LiteralPath $Source)) { return $null }
  $parent = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $parent)) { throw "Copy parent does not exist: $parent" }
  Write-Log "Copying $Source to $Destination"
  [System.IO.File]::Copy($Source, $Destination, $false)
  $sourceLength = Get-Length $Source
  $destinationLength = Get-Length $Destination
  if ($sourceLength -ne $destinationLength) { throw "Copy length mismatch: $Source -> $Destination" }
  $sourceHash = Get-Sha256 $Source
  $destinationHash = Get-Sha256 $Destination
  if ($sourceHash -ne $destinationHash) { throw "Copy hash mismatch: $Source -> $Destination" }
  return [ordered]@{ source = $Source; destination = $Destination; length = $sourceLength; sha256 = $sourceHash }
}

function Invoke-SqliteHelper([string] $Command, [string] $DatabasePath) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $Bun
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.ArgumentList.Add($sqliteHelper)
  $psi.ArgumentList.Add($Command)
  $psi.ArgumentList.Add($DatabasePath)
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  try {
    if (-not $process.Start()) { throw "Failed to start SQLite helper" }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $output = $stdout.GetAwaiter().GetResult()
    $errors = $stderr.GetAwaiter().GetResult()
    if ($errors.Trim()) { Write-Log $errors.Trim() }
    if ($process.ExitCode -ne 0) {
      throw "SQLite helper failed: command=$Command exit=$($process.ExitCode)"
    }
  } finally {
    $process.Dispose()
  }
  $line = @($output -split "`r?`n" | Where-Object { $_.Trim() })[-1]
  return $line | ConvertFrom-Json
}

function Assert-QuickCheck([object] $State, [string] $Label) {
  $quick = @($State.quickCheck)
  if ($quick.Count -ne 1 -or $quick[0] -ne "ok") {
    throw "$Label quick_check failed: $($quick -join ', ')"
  }
}

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Stop-IsolatedServer {
  if ($null -eq $server) { return }
  if (-not $server.HasExited) {
    $server.Kill($true)
    if (-not $server.WaitForExit(10000)) { throw "Isolated migration server did not exit" }
  }
}

function Start-IsolatedServer([int] $Port, [string] $Password) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $CandidateExecutable
  $psi.WorkingDirectory = $isolationDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.ArgumentList.Add("serve")
  $psi.ArgumentList.Add("--hostname")
  $psi.ArgumentList.Add("127.0.0.1")
  $psi.ArgumentList.Add("--port")
  $psi.ArgumentList.Add([string]$Port)
  foreach ($key in @($psi.Environment.Keys | Where-Object { $_ -like "OPENCODE_*" })) {
    $psi.Environment.Remove($key)
  }
  $isolatedHome = Join-Path $isolationDirectory "home"
  $temp = Join-Path $isolationDirectory "temp"
  $psi.Environment["HOME"] = $isolatedHome
  $psi.Environment["USERPROFILE"] = $isolatedHome
  $psi.Environment["XDG_CACHE_HOME"] = Join-Path $isolationDirectory "cache"
  $psi.Environment["XDG_CONFIG_HOME"] = Join-Path $isolationDirectory "config"
  $psi.Environment["XDG_DATA_HOME"] = Join-Path $isolationDirectory "data"
  $psi.Environment["XDG_STATE_HOME"] = Join-Path $isolationDirectory "state"
  $psi.Environment["TEMP"] = $temp
  $psi.Environment["TMP"] = $temp
  $psi.Environment["OPENCODE_DB"] = $workDatabase
  $psi.Environment["OPENCODE_PASSWORD"] = $Password
  $psi.Environment["OPENCODE_DISABLE_AUTOUPDATE"] = "true"
  $psi.Environment["OPENCODE_DISABLE_MODELS_FETCH"] = "true"
  $psi.Environment["OPENCODE_FILEWATCHER_DISABLE"] = "true"
  $psi.Environment["OPENCODE_DISABLE_FFF"] = "true"
  $psi.Environment["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true"
  $psi.Environment["OPENCODE_CONFIG_PROJECT_DISABLE"] = "true"
  $script:server = [System.Diagnostics.Process]::new()
  $server.StartInfo = $psi
  if (-not $server.Start()) { throw "Failed to start isolated migration server" }
  $script:stdoutTask = $server.StandardOutput.ReadToEndAsync()
  $script:stderrTask = $server.StandardError.ReadToEndAsync()
  Write-Log "Started isolated migration server pid=$($server.Id) port=$Port"
}

function Get-Authorization([string] $Password) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes("opencode:$Password")
  return "Basic " + [Convert]::ToBase64String($bytes)
}

function Wait-ForMigration([int] $Port, [string] $Password) {
  $headers = @{ Authorization = Get-Authorization $Password }
  $base = "http://127.0.0.1:$Port"
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  while ((Get-Date) -lt $deadline) {
    if ($server.HasExited) { throw "Isolated migration server exited before becoming ready" }
    try {
      Invoke-RestMethod -Uri "$base/api/health" -Headers $headers -TimeoutSec 3 | Out-Null
      break
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  if ((Get-Date) -ge $deadline) { throw "Timed out waiting for isolated server health" }
  Write-Log "Isolated server is healthy; polling V1 migration status"
  $last = ""
  while ((Get-Date) -lt $deadline) {
    if ($server.HasExited) { throw "Isolated migration server exited before migration completed" }
    $state = Invoke-RestMethod -Uri "$base/api/experimental/migration/v1" -Headers $headers -TimeoutSec 10
    $encoded = $state | ConvertTo-Json -Compress -Depth 10
    if ($encoded -ne $last) {
      Write-Log "Migration status: $encoded"
      $last = $encoded
    }
    if ($state.status -eq "completed") { return $state }
    if ($state.status -eq "error") { throw "V1 migration reported an error: $($state.error)" }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out after $TimeoutMinutes minutes waiting for V1 migration"
}

function Get-ServerOutput {
  $stdout = if ($null -ne $stdoutTask) { $stdoutTask.GetAwaiter().GetResult() } else { "" }
  $stderr = if ($null -ne $stderrTask) { $stderrTask.GetAwaiter().GetResult() } else { "" }
  return [ordered]@{
    stdout = $stdout
    stderr = $stderr
    exitCode = if ($null -ne $server) { $server.ExitCode } else { $null }
  }
}

try {
  $rootParent = Split-Path -Parent $RehearsalRoot
  if (-not (Test-Path -LiteralPath $rootParent)) { throw "Rehearsal root parent does not exist: $rootParent" }
  if (-not (Test-Path -LiteralPath $RehearsalRoot)) { New-Item -ItemType Directory -Path $RehearsalRoot | Out-Null }
  New-Item -ItemType Directory -Path $runDirectory | Out-Null
  New-Item -ItemType Directory -Path $rawDirectory | Out-Null
  New-Item -ItemType Directory -Path $workDirectory | Out-Null
  New-Item -ItemType Directory -Path $isolationDirectory | Out-Null
  foreach ($directory in @("home", "temp", "cache", "config", "data", "state")) {
    New-Item -ItemType Directory -Path (Join-Path $isolationDirectory $directory) | Out-Null
  }

  Write-Status "preflight" "running"
  foreach ($path in @($Bun, $sqliteHelper, $SourceDatabase, $CandidateExecutable)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required path does not exist: $path" }
  }
  Assert-NoOpenCode
  Protect-SourceFile $SourceDatabase
  Protect-SourceFile $sourceWal
  Protect-SourceFile $sourceShm
  Assert-NoOpenCode

  $candidateVersion = ((& $CandidateExecutable --version) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $candidateVersion -ne $expectedVersion) {
    throw "Candidate version check failed: $candidateVersion"
  }
  $candidateHash = Get-Sha256 $CandidateExecutable
  $sourceBytes = Get-Length $SourceDatabase
  $walBytes = Get-Length $sourceWal
  $shmBytes = Get-Length $sourceShm
  $requiredBytes = (3L * $sourceBytes) + (3L * $walBytes) + $shmBytes + 2GB
  $freeBytes = Get-FreeBytes $RehearsalRoot
  if ($freeBytes -lt $requiredBytes) {
    throw "Insufficient rehearsal drive space: free=$freeBytes required=$requiredBytes"
  }
  $sourceHashes = [ordered]@{
    database = Get-Sha256 $SourceDatabase
    wal = if (Test-Path -LiteralPath $sourceWal) { Get-Sha256 $sourceWal } else { $null }
    shm = if (Test-Path -LiteralPath $sourceShm) { Get-Sha256 $sourceShm } else { $null }
  }
  Write-Status "preflight" "passed" @{
    candidate = @{ version = $candidateVersion; sha256 = $candidateHash }
    source = @{
      database = @{ path = $SourceDatabase; length = $sourceBytes; sha256 = $sourceHashes.database }
      wal = @{ path = $sourceWal; length = $walBytes; sha256 = $sourceHashes.wal }
      shm = @{ path = $sourceShm; length = $shmBytes; sha256 = $sourceHashes.shm }
    }
    capacity = @{ freeBytes = $freeBytes; requiredBytes = $requiredBytes }
  }

  Write-Status "copy" "running"
  $copies = @(
    Copy-Verified $SourceDatabase $rawDatabase
    Copy-Verified $sourceWal (Join-Path $rawDirectory ($databaseName + "-wal"))
    Copy-Verified $sourceShm (Join-Path $rawDirectory ($databaseName + "-shm"))
    Copy-Verified $rawDatabase $workDatabase
    Copy-Verified (Join-Path $rawDirectory ($databaseName + "-wal")) (Join-Path $workDirectory ($databaseName + "-wal"))
    Copy-Verified (Join-Path $rawDirectory ($databaseName + "-shm")) (Join-Path $workDirectory ($databaseName + "-shm"))
  ) | Where-Object { $null -ne $_ }
  Assert-NoOpenCode
  $checkpoint = Invoke-SqliteHelper "checkpoint-copy" $workDatabase
  Assert-QuickCheck $checkpoint "working database after WAL checkpoint"
  if ((Get-Length ($workDatabase + "-wal")) -ne 0) { throw "Working copy WAL was not truncated" }
  $workBefore = Invoke-SqliteHelper "inspect-source" $workDatabase
  Assert-QuickCheck $workBefore "working database before migration"
  Write-Status "copy" "passed" @{ copies = $copies; checkpoint = $checkpoint; work = $workBefore }

  Write-Status "migration" "running"
  $port = Get-FreeTcpPort
  $password = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
  Start-IsolatedServer $port $password
  $migration = Wait-ForMigration $port $password
  Stop-IsolatedServer
  $serverOutput = Get-ServerOutput
  Set-Content -LiteralPath (Join-Path $runDirectory "server.stdout.log") -Value $serverOutput.stdout -Encoding utf8
  Set-Content -LiteralPath (Join-Path $runDirectory "server.stderr.log") -Value $serverOutput.stderr -Encoding utf8
  $postCheckpoint = Invoke-SqliteHelper "checkpoint-copy" $workDatabase
  Assert-QuickCheck $postCheckpoint "migrated working database"
  $verification = Invoke-SqliteHelper "verify-migrated" $workDatabase
  $script:failureEvidence = [ordered]@{
    migration = $migration
    checkpoint = $postCheckpoint
    verification = $verification
    sourceUnchanged = $false
  }
  if (-not $verification.passed) {
    throw "Migrated database verification failed; inspect status.json and rehearsal.log"
  }

  if (-not (Test-Path -LiteralPath $SourceDatabase)) { throw "Source database disappeared during rehearsal" }
  if ((Get-Sha256 $SourceDatabase) -ne $sourceHashes.database) { throw "Source database changed during rehearsal" }
  if ($null -eq $sourceHashes.wal) {
    if (Test-Path -LiteralPath $sourceWal) { throw "Source WAL appeared during rehearsal" }
  } elseif (-not (Test-Path -LiteralPath $sourceWal) -or (Get-Sha256 $sourceWal) -ne $sourceHashes.wal) {
    throw "Source WAL changed or disappeared during rehearsal"
  }
  if ($null -eq $sourceHashes.shm) {
    if (Test-Path -LiteralPath $sourceShm) { throw "Source SHM appeared during rehearsal" }
  } elseif (-not (Test-Path -LiteralPath $sourceShm) -or (Get-Sha256 $sourceShm) -ne $sourceHashes.shm) {
    throw "Source SHM changed or disappeared during rehearsal"
  }
  $failureEvidence.sourceUnchanged = $true

  if (-not $AllowMigrationWarnings -and [int64]$verification.warningCount -gt 0) {
    throw "Migration produced $($verification.warningCount) warning(s); rerun only after reviewing them"
  }
  Write-Status "migration" "passed" $failureEvidence

  $result = [ordered]@{
    sourceSnapshot = $workBefore
    sourceHashes = $sourceHashes
    candidate = @{ path = $CandidateExecutable; version = $candidateVersion; sha256 = $candidateHash }
    migratedDatabase = $workDatabase
    rawCopy = $rawDatabase
    verification = $verification
  }
  Write-Status "complete" "passed" $result
  Set-Content -LiteralPath $completePath -Value "V1 TO V2 COPY-ONLY REHEARSAL COMPLETE" -Encoding utf8
  Write-Log "COPY-ONLY REHEARSAL COMPLETE. The source database and active binary were not modified."
  Write-Log "Migrated copy: $workDatabase"
} catch {
  $message = $_.Exception.Message
  try { Stop-IsolatedServer } catch {}
  $output = $null
  try { $output = Get-ServerOutput } catch {}
  if ($null -ne $output -and (Test-Path -LiteralPath $runDirectory)) {
    Set-Content -LiteralPath (Join-Path $runDirectory "server.stdout.log") -Value $output.stdout -Encoding utf8
    Set-Content -LiteralPath (Join-Path $runDirectory "server.stderr.log") -Value $output.stderr -Encoding utf8
  }
  if (Test-Path -LiteralPath $runDirectory) {
    Write-Status "failed" "failed" @{ error = $message; evidence = $failureEvidence }
    Set-Content -LiteralPath $failedPath -Value $message -Encoding utf8
    Write-Log "COPY-ONLY REHEARSAL FAILED: $message"
  }
  throw
} finally {
  foreach ($guard in $sourceGuards) { $guard.Dispose() }
  if ($null -ne $server) { $server.Dispose() }
}
