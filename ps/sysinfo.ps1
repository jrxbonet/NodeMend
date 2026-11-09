# Fast system snapshot for the dashboard. Prints one JSON document.
$ErrorActionPreference = 'SilentlyContinue'
$os  = Get-CimInstance Win32_OperatingSystem
$cs  = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpu = Get-CimInstance Win32_VideoController | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS

$vols = Get-Volume | Where-Object { $_.DriveLetter } | Sort-Object DriveLetter | ForEach-Object {
  [pscustomobject]@{ letter = "$($_.DriveLetter)"; label = $_.FileSystemLabel; fs = $_.FileSystem
    size = [int64]$_.Size; free = [int64]$_.SizeRemaining; health = "$($_.HealthStatus)" }
}
$disks = Get-PhysicalDisk | ForEach-Object {
  $rc = $_ | Get-StorageReliabilityCounter
  [pscustomobject]@{ name = $_.FriendlyName; media = "$($_.MediaType)"; bus = "$($_.BusType)"; size = [int64]$_.Size
    health = "$($_.HealthStatus)"; status = "$($_.OperationalStatus)"
    temp = $rc.Temperature; wear = $rc.Wear; readErrors = $rc.ReadErrorsTotal; hours = $rc.PowerOnHours }
}
$pendingReboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
                 (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
$def = Get-MpComputerStatus
$lastHotfix = Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 1

[pscustomobject]@{
  os = $os.Caption; version = $os.Version; build = $os.BuildNumber; displayVersion = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').DisplayVersion
  lastBoot = $os.LastBootUpTime.ToString('s'); uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
  model = ($cs.Manufacturer + ' ' + $cs.Model).Trim(); bios = ($bios.Manufacturer + ' ' + $bios.SMBIOSBIOSVersion).Trim()
  ramTotal = [int64]$cs.TotalPhysicalMemory; ramFree = [int64]$os.FreePhysicalMemory * 1KB
  cpu = $cpu.Name.Trim(); cpuLoad = $cpu.LoadPercentage; cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors
  gpu = $gpu.Name; gpuDriver = $gpu.DriverVersion
  volumes = @($vols); disks = @($disks)
  pendingReboot = $pendingReboot
  defender = [pscustomobject]@{ realtime = $def.RealTimeProtectionEnabled; sigVersion = $def.AntivirusSignatureVersion; sigAgeDays = $def.AntivirusSignatureAge
    lastQuick = if ($def.QuickScanEndTime) { $def.QuickScanEndTime.ToString('s') } else { $null }
    lastFull  = if ($def.FullScanEndTime)  { $def.FullScanEndTime.ToString('s') }  else { $null } }
  lastHotfix = if ($lastHotfix) { "$($lastHotfix.HotFixID) ($($lastHotfix.InstalledOn.ToString('yyyy-MM-dd')))" } else { 'n/a' }
} | ConvertTo-Json -Depth 5 -Compress
