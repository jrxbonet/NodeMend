# Manage the weekly "NodeMend Maintenance" scheduled task (runs as SYSTEM, highest privileges).
#   -Install -Exe <path> -Arguments <string> [-Day Sunday] [-Time 03:00]
#   -Remove
#   -Status
# Always prints one JSON document; exit 0 on success, 1 on error. Install/Remove need an elevated
# console (the Enterprise UI is normally elevated); Status works unelevated.
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Status,
  [string]$Exe,
  [string]$Arguments = '',   # not $Args: that is PowerShell's automatic variable and is always empty here
  [ValidateSet('Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday')][string]$Day = 'Sunday',
  [ValidatePattern('^\d{1,2}:\d{2}$')][string]$Time = '03:00'
)
$ErrorActionPreference = 'Stop'
$name = 'NodeMend Maintenance'
$legacyName = 'TidyWin Maintenance'

function Assert-ProtectedExecutable([string]$Candidate) {
  $reason = 'SYSTEM scheduling requires an installed executable in a protected Program Files folder; portable/development or user-writable paths are refused.'
  if (-not [IO.Path]::IsPathRooted($Candidate) -or $Candidate -notmatch '^[A-Za-z]:\\' -or $Candidate.Substring(2).Contains(':')) { throw $reason }
  $full = [IO.Path]::GetFullPath($Candidate)
  $roots = @([Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86')) | Where-Object { $_ } | Select-Object -Unique
  $root = $roots | Where-Object { $full.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
  if (-not $root -or [IO.Path]::GetExtension($full) -ine '.exe' -or [IO.Path]::GetFileName($full) -ieq 'electron.exe') { throw $reason }
  $installDir = Split-Path -Parent $full
  if ($installDir.TrimEnd('\') -ieq $root.TrimEnd('\')) { throw "$reason Use a dedicated application folder." }
  $item = Get-Item -LiteralPath $full -Force
  if ($item.PSIsContainer) { throw $reason }
  $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') # SYSTEM, Administrators, TrustedInstaller
  $writeMask = [Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
  function Assert-TrustedEntry([string]$Target) {
    $entry = Get-Item -LiteralPath $Target -Force
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$reason Reparse point: $Target" }
    $acl = Get-Acl -LiteralPath $Target
    # An unprivileged owner can rewrite the DACL even without a write ACE.
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw "$reason Unsafe owner: $Target" }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      $rights = [int64]$rule.FileSystemRights
      $unsafeRights = ($rights -lt 0) -or ($rights -band 0x10000000) -or ($rights -band 0x40000000) -or ($rights -band $writeMask)
      if ($rule.AccessControlType -eq 'Allow' -and
          -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
          $unsafeRights -and $rule.IdentityReference.Value -notin $trusted) { throw "$reason Unsafe permissions: $Target" }
    }
  }
  # Electron loads adjacent DLLs and resources/app (including JS and PowerShell).
  # The entire dedicated installation must be protected, not just the launcher.
  $pending = New-Object 'System.Collections.Generic.Queue[string]'
  $pending.Enqueue($installDir)
  while ($pending.Count) {
    $current = $pending.Dequeue()
    Assert-TrustedEntry $current
    foreach ($child in Get-ChildItem -LiteralPath $current -Force) {
      Assert-TrustedEntry $child.FullName
      if ($child.PSIsContainer) { $pending.Enqueue($child.FullName) }
    }
  }
  $cursor = $installDir
  while ($cursor) {
    Assert-TrustedEntry $cursor
    if ($cursor.TrimEnd('\') -ieq $root.TrimEnd('\')) { break }
    $cursor = Split-Path -Parent $cursor
  }
  return $full
}

function Get-State {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $t) { $t = Get-ScheduledTask -TaskName $legacyName -ErrorAction SilentlyContinue }
  if (-not $t) { return [ordered]@{ ok = $true; installed = $false; name = $name } }
  $i = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
  $a = $t.Actions | Select-Object -First 1
  $tr = $t.Triggers | Select-Object -First 1
  $fmt = { param($d) if ($d -and $d.Year -gt 1900) { $d.ToString('s') } else { $null } }
  [ordered]@{
    ok = $true; installed = $true; name = $t.TaskName; legacy = ($t.TaskName -eq $legacyName); state = [string]$t.State
    exe = $a.Execute; args = $a.Arguments; runAs = $t.Principal.UserId; runLevel = [string]$t.Principal.RunLevel
    days = @($tr.DaysOfWeek | ForEach-Object { [string]$_ }); startAt = (& $fmt $tr.StartBoundary)
    lastRunTime = (& $fmt $i.LastRunTime); lastResult = $i.LastTaskResult; nextRunTime = (& $fmt $i.NextRunTime)
  }
}

try {
  if ($Install) {
    if (-not $Exe) { throw '-Exe is required with -Install' }
    $Exe = Assert-ProtectedExecutable $Exe
    if (Get-ScheduledTask -TaskName $legacyName -ErrorAction SilentlyContinue) { throw 'Remove the legacy TidyWin Maintenance task from the License tab before installing NodeMend Maintenance.' }
    $action = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments -WorkingDirectory (Split-Path -Parent $Exe)
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $Time
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4) -StartWhenAvailable -MultipleInstances IgnoreNew `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Compatibility Win8
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
      -Description 'NodeMend Enterprise unattended maintenance (installed from the License tab)' -Force | Out-Null
    $out = Get-State; $out.action = 'install'
  }
  elseif ($Remove) {
    $existed = $false
    foreach ($taskName in @($name, $legacyName)) {
      if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        $existed = $true
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
      }
    }
    $out = Get-State; $out.action = 'remove'; $out.removed = $existed
  }
  else {
    $out = Get-State; $out.action = 'status'
  }
  [pscustomobject]$out | ConvertTo-Json -Compress -Depth 4
  exit 0
}
catch {
  [pscustomobject]@{ ok = $false; installed = $null; name = $name; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
