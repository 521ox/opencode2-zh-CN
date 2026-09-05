import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

export type PrivacyInspection = {
  platform: "windows" | "posix"
  protected: boolean
  allowed_sids?: string[]
  expected_sids?: string[]
  mode?: number
}

export type PrivacyController = {
  secureDirectory(target: string): Promise<void>
  secureFile(target: string): Promise<void>
  verifyDirectory(target: string): Promise<void>
  verifyFile(target: string): Promise<void>
  inspectDirectory(target: string): Promise<PrivacyInspection>
  inspectFile(target: string): Promise<PrivacyInspection>
}

export type ScopedPrivacyController = PrivacyController & {
  invalidateDirectory(target: string): void
  invalidateFile(target: string): void
}

export function scopePrivacyController(base: PrivacyController): ScopedPrivacyController {
  const directories = new Set<string>()
  const files = new Set<string>()
  return {
    secureDirectory: async (target) => {
      await base.secureDirectory(target)
      directories.add(target)
    },
    secureFile: async (target) => {
      await base.secureFile(target)
      files.add(target)
    },
    verifyDirectory: async (target) => {
      if (directories.has(target)) return
      await base.verifyDirectory(target)
      directories.add(target)
    },
    verifyFile: async (target) => {
      if (files.has(target)) return
      await base.verifyFile(target)
      files.add(target)
    },
    inspectDirectory: async (target) => await base.inspectDirectory(target),
    inspectFile: async (target) => await base.inspectFile(target),
    invalidateDirectory: (target) => directories.delete(target),
    invalidateFile: (target) => files.delete(target),
  }
}

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$target = $env:SESSION_SNAPSHOT_ACL_TARGET
$kind = $env:SESSION_SNAPSHOT_ACL_KIND
$mode = $env:SESSION_SNAPSHOT_ACL_MODE
if ([string]::IsNullOrWhiteSpace($target)) { throw "Missing ACL target" }
if ($kind -ne "directory" -and $kind -ne "file") { throw "Invalid ACL kind" }
if ($mode -ne "secure" -and $mode -ne "verify") { throw "Invalid ACL mode" }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$sections = [System.Security.AccessControl.AccessControlSections]::Access
if ($kind -eq "directory") {
  $item = New-Object System.IO.DirectoryInfo($target)
} else {
  $item = New-Object System.IO.FileInfo($target)
}
if ($mode -eq "secure") {
  $acl = $item.GetAccessControl($sections)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
    [void]$acl.RemoveAccessRuleSpecific($rule)
  }
  $acl.SetOwner($current)
  if ($kind -eq "directory") {
    $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $inherit = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($current, $rights, $inherit, $propagation, $allow)))
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, $rights, $inherit, $propagation, $allow)))
  $item.SetAccessControl($acl)
}
$check = $item.GetAccessControl($sections)
if (-not $check.AreAccessRulesProtected) { throw "ACL inheritance remains enabled" }
$rules = @($check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$expected = @($current.Value, $system.Value)
$seen = @{}
foreach ($rule in $rules) {
  $sid = $rule.IdentityReference.Value
  if ($expected -notcontains $sid) { throw "Unexpected ACL principal: $sid" }
  if ($rule.AccessControlType -ne $allow) { throw "Unexpected deny ACL for: $sid" }
  if (($rule.FileSystemRights -band $rights) -ne $rights) { throw "Missing full control for: $sid" }
  $seen[$sid] = $true
}
foreach ($sid in $expected) { if (-not $seen.ContainsKey($sid)) { throw "Missing ACL principal: $sid" } }
[ordered]@{
  protected = $check.AreAccessRulesProtected
  allowed_sids = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
  expected_sids = @($expected | Sort-Object -Unique)
} | ConvertTo-Json -Compress
`

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows"
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

function executeWindowsAcl(target: string, kind: "directory" | "file", mode: "secure" | "verify"): Promise<PrivacyInspection> {
  return new Promise((resolve, reject) => {
    execFile(
      windowsPowerShellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_ACL_SCRIPT],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SESSION_SNAPSHOT_ACL_TARGET: target,
          SESSION_SNAPSHOT_ACL_KIND: kind,
          SESSION_SNAPSHOT_ACL_MODE: mode,
        },
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Windows ACL ${mode} failed for ${target}: ${stderr.trim() || error.message}`, { cause: error }))
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as Omit<PrivacyInspection, "platform">
          resolve({ platform: "windows", ...parsed })
        } catch (parseError) {
          reject(new Error(`Windows ACL ${mode} returned invalid evidence for ${target}`, { cause: parseError }))
        }
      },
    )
  })
}

async function inspectPosix(target: string, directory: boolean): Promise<PrivacyInspection> {
  const stats = await fs.lstat(target)
  if (stats.isSymbolicLink()) throw new Error(`Privacy target is a symbolic link: ${target}`)
  if (directory ? !stats.isDirectory() : !stats.isFile()) throw new Error(`Privacy target has the wrong type: ${target}`)
  const mode = stats.mode & 0o777
  return { platform: "posix", protected: (mode & 0o077) === 0, mode }
}

async function verifyPosix(target: string, directory: boolean): Promise<void> {
  const inspection = await inspectPosix(target, directory)
  const expected = directory ? 0o700 : 0o600
  if (!inspection.protected || inspection.mode !== expected) {
    throw new Error(`POSIX privacy mode mismatch for ${target}: expected ${expected.toString(8)}, got ${inspection.mode?.toString(8)}`)
  }
}

export function createPrivacyController(platform = process.platform): PrivacyController {
  if (platform === "win32") {
    return {
      secureDirectory: async (target) => void (await executeWindowsAcl(target, "directory", "secure")),
      secureFile: async (target) => void (await executeWindowsAcl(target, "file", "secure")),
      verifyDirectory: async (target) => void (await executeWindowsAcl(target, "directory", "verify")),
      verifyFile: async (target) => void (await executeWindowsAcl(target, "file", "verify")),
      inspectDirectory: async (target) => await executeWindowsAcl(target, "directory", "verify"),
      inspectFile: async (target) => await executeWindowsAcl(target, "file", "verify"),
    }
  }
  return {
    secureDirectory: async (target) => {
      await fs.chmod(target, 0o700)
      await verifyPosix(target, true)
    },
    secureFile: async (target) => {
      await fs.chmod(target, 0o600)
      await verifyPosix(target, false)
    },
    verifyDirectory: async (target) => await verifyPosix(target, true),
    verifyFile: async (target) => await verifyPosix(target, false),
    inspectDirectory: async (target) => await inspectPosix(target, true),
    inspectFile: async (target) => await inspectPosix(target, false),
  }
}
