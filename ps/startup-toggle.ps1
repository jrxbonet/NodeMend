# Enable or disable a startup entry the same way Task Manager does (StartupApproved registry bytes).
# Nothing is deleted - the Run value / shortcut stays in place, Windows just skips it at logon.
param(
  [Parameter(Mandatory)][string]$Name,
  [Parameter(Mandatory)][ValidateSet('HKCU:', 'HKLM:')][string]$Hive,
  [Parameter(Mandatory)][ValidateSet('Run', 'Run32', 'StartupFolder')][string]$Key,
  [Parameter(Mandatory)][ValidateSet('true', 'false', '$true', '$false')][string]$Enable
)
$enableStartup = $Enable -in @('true', '$true')
$ErrorActionPreference = 'Stop'
$path = "$Hive\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\$Key"
if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
$bytes = New-Object byte[] 12
if ($enableStartup) { $bytes[0] = 0x02 }
else {
  $bytes[0] = 0x03
  $ft = [BitConverter]::GetBytes((Get-Date).ToFileTime())
  [Array]::Copy($ft, 0, $bytes, 4, 8)
}
Set-ItemProperty -Path $path -Name $Name -Value $bytes -Type Binary
[pscustomobject]@{ ok = $true; name = $Name; enabled = $enableStartup } | ConvertTo-Json -Compress
