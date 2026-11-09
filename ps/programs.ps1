# Enumerate installed software: classic programs from the three Uninstall registry hives
# plus Microsoft Store (Appx) packages. Prints one JSON array. No changes are made here.
$ErrorActionPreference = 'SilentlyContinue'

$hives = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$seen = @{}
$list = New-Object System.Collections.ArrayList

foreach ($h in $hives) {
  $scope = if ($h -like 'HKCU*') { 'user' } else { 'machine' }
  foreach ($k in Get-ItemProperty $h) {
    $name = $k.DisplayName
    if (-not $name) { continue }
    if ($k.SystemComponent -eq 1) { continue }               # hidden system entries
    if ($k.ParentKeyName) { continue }                        # updates/patches attached to a parent
    if (-not $k.UninstallString -and -not $k.QuietUninstallString) { continue }
    $key = "$name|$($k.DisplayVersion)"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $date = $null
    if ($k.InstallDate -match '^\d{8}$') { try { $date = [datetime]::ParseExact($k.InstallDate, 'yyyyMMdd', $null).ToString('yyyy-MM-dd') } catch {} }
    [void]$list.Add([pscustomobject]@{
      id = $k.PSChildName; name = $name; version = "$($k.DisplayVersion)"; publisher = "$($k.Publisher)"
      installDate = $date; sizeMB = if ($k.EstimatedSize) { [math]::Round($k.EstimatedSize / 1024, 1) } else { $null }  # EstimatedSize is in KB
      location = "$($k.InstallLocation)"; scope = $scope; kind = 'registry'
      uninstall = "$($k.UninstallString)"; quiet = "$($k.QuietUninstallString)"
      icon = "$($k.DisplayIcon)"; url = "$($k.URLInfoAbout)"
    })
  }
}

# Microsoft Store / Appx packages (per-user)
foreach ($p in Get-AppxPackage) {
  if ($p.IsFramework -or $p.SignatureKind -eq 'System' -or $p.NonRemovable) { continue }
  $manifest = $null; try { $manifest = Get-AppxPackageManifest $p } catch {}
  $disp = $p.Name
  if ($manifest -and $manifest.Package.Properties.DisplayName -and $manifest.Package.Properties.DisplayName -notlike 'ms-resource:*') { $disp = $manifest.Package.Properties.DisplayName }
  [void]$list.Add([pscustomobject]@{
    id = $p.PackageFullName; name = $disp; version = "$($p.Version)"
    publisher = ($p.Publisher -replace '^CN=', '' -replace ',.*$', '')
    installDate = $null; sizeMB = $null; location = "$($p.InstallLocation)"; scope = 'user'; kind = 'appx'
    uninstall = ''; quiet = ''; icon = ''; url = '' })
}

ConvertTo-Json -InputObject @($list | Sort-Object name) -Depth 3 -Compress
