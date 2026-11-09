# Startup programs with their enabled/disabled state (as shown by Task Manager). Prints a JSON array.
$ErrorActionPreference = 'SilentlyContinue'

function ApprovedState($hive, $key, $name) {
  # StartupApproved values: byte[0] = 0x02 enabled, 0x03 (or odd) disabled
  $v = Get-ItemProperty -Path "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\$key" -Name $name
  if ($null -eq $v) { return $true }
  $bytes = $v.$name
  if ($null -eq $bytes -or $bytes.Length -eq 0) { return $true }
  return (($bytes[0] % 2) -eq 0)
}

$items = @()
foreach ($hive in @('HKCU:', 'HKLM:')) {
  foreach ($sub in @('Run', 'RunOnce')) {
    $k = Get-Item "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\$sub"
    if (-not $k) { continue }
    foreach ($n in $k.GetValueNames()) {
      if (-not $n) { continue }
      $items += [pscustomobject]@{ name = $n; command = $k.GetValue($n); location = "$hive\...\$sub"
        scope = if ($hive -eq 'HKCU:') { 'user' } else { 'machine' }
        kind = 'registry'; hive = $hive; key = $sub
        enabled = if ($sub -eq 'Run') { ApprovedState $hive 'Run' $n } else { $true } }
    }
  }
  # 32-bit view on 64-bit Windows
  if ($hive -eq 'HKLM:') {
    $k = Get-Item "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"
    if ($k) { foreach ($n in $k.GetValueNames()) { if ($n) {
      $items += [pscustomobject]@{ name = $n; command = $k.GetValue($n); location = 'HKLM:\...\WOW6432Node\Run'; scope = 'machine'; kind = 'registry'; hive = 'HKLM:'; key = 'Run32'; enabled = (ApprovedState 'HKLM:' 'Run32' $n) } } } }
  }
}
$folders = @(
  @{ path = [Environment]::GetFolderPath('Startup'); scope = 'user'; hive = 'HKCU:' },
  @{ path = [Environment]::GetFolderPath('CommonStartup'); scope = 'machine'; hive = 'HKLM:' })
foreach ($f in $folders) {
  if (-not (Test-Path $f.path)) { continue }
  Get-ChildItem $f.path -File | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object {
    $items += [pscustomobject]@{ name = $_.Name; command = $_.FullName; location = 'Startup folder'; scope = $f.scope; kind = 'folder'; hive = $f.hive; key = 'StartupFolder'
      enabled = (ApprovedState $f.hive 'StartupFolder' $_.Name) }
  }
}
ConvertTo-Json -InputObject @($items) -Depth 3 -Compress
