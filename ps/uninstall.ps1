# Uninstall one program. Streams progress lines; final line is @@JSON.
#   -Kind registry -Id <guid-or-key> -Uninstall <string> [-Quiet <string>] [-Silent]
#   -Kind appx     -Id <PackageFullName>
# Registry programs run their own uninstaller. MSI entries are converted to a real removal
# (msiexec /x {guid} /qb). NSIS/Inno silent switches are added only when -Silent is set and
# no QuietUninstallString is supplied; otherwise the vendor uninstaller UI is shown.
param(
  [ValidateSet('registry', 'appx')][string]$Kind = 'registry',
  [string]$Id, [string]$Uninstall, [string]$Quiet, [switch]$Silent
)
$ErrorActionPreference = 'Stop'
function Emit($obj) { Write-Output ('@@JSON ' + ($obj | ConvertTo-Json -Compress)) }

try {
  if ($Kind -eq 'appx') {
    Write-Output "Removing Microsoft Store app $Id ..."
    Remove-AppxPackage -Package $Id -ErrorAction Stop
    Write-Output 'Removed.'
    Emit @{ ok = $true; kind = 'appx' }
    return
  }

  $cmd = if ($Silent -and $Quiet) { $Quiet } else { $Uninstall }
  if (-not $cmd -and $Quiet) { $cmd = $Quiet }
  if (-not $cmd) { throw 'No uninstall command recorded for this program.' }

  # MSI: rewrite to a proper silent/basic-UI removal by product code.
  $guid = $null
  if ($cmd -match '(\{[0-9A-Fa-f\-]{36}\})') { $guid = $matches[1] }
  elseif ($Id -match '^\{[0-9A-Fa-f\-]{36}\}$') { $guid = $Id }
  if ($cmd -match '(?i)msiexec' -and $guid) {
    $ui = if ($Silent) { '/qn' } else { '/qb' }   # /qb shows a basic progress bar, no prompts
    Write-Output "Uninstalling MSI $guid ($ui) ..."
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList "/x $guid $ui /norestart" -PassThru -Wait
    Write-Output "msiexec exit code: $($p.ExitCode)"
    Emit @{ ok = ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010); exitCode = $p.ExitCode; rebootRequired = ($p.ExitCode -eq 3010) }
    return
  }

  # Non-MSI (EXE) uninstaller: split the command line into file + args honoring quotes.
  $file = $null; $args = ''
  if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') { $file = $matches[1]; $args = $matches[2] }
  elseif ($cmd -match '^\s*(\S+\.exe)\s*(.*)$') { $file = $matches[1]; $args = $matches[2] }
  else { $file = $cmd }

  if ($Silent -and -not $Quiet) {
    $lf = $file.ToLower()
    if ($args -notmatch '/S|/silent|/verysilent|/qn|/qb') {
      if ($lf -match 'unins\d*\.exe$') { $args = "$args /VERYSILENT /NORESTART" }        # Inno Setup
      elseif ($lf -match 'uninstall.*\.exe$|uninst.*\.exe$') { $args = "$args /S" }        # NSIS
    }
  }
  Write-Output "Running: $file $args"
  $p = Start-Process -FilePath $file -ArgumentList $args -PassThru -Wait
  Write-Output "Uninstaller exit code: $($p.ExitCode)"
  Emit @{ ok = ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010 -or $null -eq $p.ExitCode); exitCode = $p.ExitCode }
}
catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
  Emit @{ ok = $false; error = $_.Exception.Message }
}
