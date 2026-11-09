# Deeper diagnostics: event log errors, crashes, services, memory, SMART. Prints one JSON document.
param([int]$Days = 7)
$ErrorActionPreference = 'SilentlyContinue'
$since = (Get-Date).AddDays(-$Days)

$ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'System', 'Application'; Level = 1, 2; StartTime = $since })
$bySource = $ev | Group-Object ProviderName | Sort-Object Count -Descending | Select-Object -First 15 | ForEach-Object {
  [pscustomobject]@{ source = $_.Name; count = $_.Count }
}
$recent = $ev | Select-Object -First 25 | ForEach-Object {
  $m = ($_.Message -split "`n")[0]; if ($m.Length -gt 220) { $m = $m.Substring(0, 220) + '...' }
  [pscustomobject]@{ time = $_.TimeCreated.ToString('s'); source = $_.ProviderName; id = $_.Id; level = "$($_.LevelDisplayName)"; message = $m }
}
$crashes = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 6008, 1001, 41; StartTime = (Get-Date).AddDays(-30) }) | ForEach-Object {
  [pscustomobject]@{ time = $_.TimeCreated.ToString('s'); id = $_.Id; source = $_.ProviderName }
}
$appCrashes = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000, 1002; StartTime = $since }) | ForEach-Object {
  $m = ($_.Message -split "`n")[0]; if ($m.Length -gt 160) { $m = $m.Substring(0, 160) }
  [pscustomobject]@{ time = $_.TimeCreated.ToString('s'); id = $_.Id; message = $m }
}
$stopped = Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; display = $_.DisplayName }
}
$page = Get-CimInstance Win32_PageFileUsage | ForEach-Object { [pscustomobject]@{ name = $_.Name; allocMB = $_.AllocatedBaseSize; peakMB = $_.PeakUsage; currentMB = $_.CurrentUsage } }
$top = Get-Process | Sort-Object WS -Descending | Select-Object -First 10 | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; ws = [int64]$_.WS; cpu = [math]::Round($_.CPU, 0) } }
$smart = Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus | ForEach-Object { [pscustomobject]@{ instance = $_.InstanceName; predictFailure = $_.PredictFailure } }
$pendingReboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
                 (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
$memDiag = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-MemoryDiagnostics-Results' } -MaxEvents 1
$net = Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object { [pscustomobject]@{ name = $_.Name; desc = $_.InterfaceDescription; speed = $_.LinkSpeed } }
$battery = Get-CimInstance Win32_Battery | Select-Object -First 1
$restorePoints = @(Get-ComputerRestorePoint | Sort-Object CreationTime -Descending | Select-Object -First 3 | ForEach-Object {
  [pscustomobject]@{ desc = $_.Description; time = ([management.managementDateTimeConverter]::ToDateTime($_.CreationTime)).ToString('s') } })

[pscustomobject]@{
  days = $Days; errorCount = $ev.Count; bySource = @($bySource); recent = @($recent)
  crashes = @($crashes); appCrashes = @($appCrashes)
  stoppedAutoServices = @($stopped); pagefile = @($page); topProcesses = @($top); smart = @($smart)
  pendingReboot = $pendingReboot
  memoryDiag = if ($memDiag) { ($memDiag.Message -split "`n")[0] } else { $null }
  network = @($net)
  battery = if ($battery) { [pscustomobject]@{ charge = $battery.EstimatedChargeRemaining; status = $battery.BatteryStatus } } else { $null }
  restorePoints = $restorePoints
} | ConvertTo-Json -Depth 5 -Compress
