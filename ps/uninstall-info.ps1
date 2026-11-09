# Private read-only lookup for main; renderer input never supplies a command line.
param([Parameter(Mandatory = $true)][string]$Id)
$ErrorActionPreference = 'Stop'
try {
  if ($Id -in @('.', '..') -or $Id -match '[\\/\x00-\x1f]' -or $Id.Length -gt 255) { throw 'Invalid program id.' }
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $entries = @($roots | ForEach-Object {
    $key = Join-Path $_ $Id
    if (Test-Path -LiteralPath $key) { @{ entry = (Get-ItemProperty -LiteralPath $key); scope = $(if ($_ -like 'HKCU:*') { 'user' } else { 'machine' }) } }
  })
  # Ids shared by multiple hives are ambiguous. Refresh the list rather than guess.
  if ($entries.Count -ne 1) { throw 'Program missing or ambiguous in the registry; refresh the program list.' }
  $entry = $entries[0].entry
  if (-not $entry.DisplayName -or $entry.SystemComponent -eq 1 -or $entry.ParentKeyName) { throw 'Program is not an uninstallable application.' }
  if (-not $entry.UninstallString -and -not $entry.QuietUninstallString) { throw 'No uninstall command recorded for this program.' }
  @{ ok = $true; name = [string]$entry.DisplayName; scope = $entries[0].scope; uninstall = [string]$entry.UninstallString; quiet = [string]$entry.QuietUninstallString } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
