# Download and install all pending (non-hidden) Windows updates. Streams progress lines; final line is @@JSON.
# -Drivers: install driver updates from the Microsoft Update channel (all vendors) instead of
# the regular Windows Update software channel. -Ids limits the install to specific UpdateIDs.
param([switch]$Drivers, [string[]]$Ids = @())
$ErrorActionPreference = 'Stop'
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $session.ClientApplicationID = 'NodeMend'
  $searcher = $session.CreateUpdateSearcher()
  $criteria = 'IsInstalled=0 and IsHidden=0'
  if ($Drivers) {
    $sm = New-Object -ComObject Microsoft.Update.ServiceManager
    $null = $sm.AddService2('7971f918-a847-4430-9279-4a52d1efe18d', 7, '')
    $searcher.ServerSelection = 3; $searcher.ServiceID = '7971f918-a847-4430-9279-4a52d1efe18d'; $searcher.Online = $true
    $criteria = "IsInstalled=0 and Type='Driver' and IsHidden=0"
  }
  Write-Output ("Searching for " + $(if ($Drivers) { 'driver' } else { 'Windows' }) + " updates...")
  $found = $searcher.Search($criteria)
  $result = New-Object -ComObject Microsoft.Update.UpdateColl
  foreach ($u in $found.Updates) { if ($Ids.Count -eq 0 -or $Ids -contains $u.Identity.UpdateID) { $result.Add($u) | Out-Null } }
  $result = [pscustomobject]@{ Updates = $result }
  if ($result.Updates.Count -eq 0) { Write-Output 'No pending updates.'; Write-Output '@@JSON {"ok":true,"installed":0,"rebootRequired":false}'; exit 0 }

  $toDownload = New-Object -ComObject Microsoft.Update.UpdateColl
  foreach ($u in $result.Updates) {
    if (-not $u.EulaAccepted) { $u.AcceptEula() | Out-Null }
    if (-not $u.IsDownloaded) { $toDownload.Add($u) | Out-Null }
    Write-Output ("  queued: " + $u.Title)
  }
  if ($toDownload.Count -gt 0) {
    Write-Output "Downloading $($toDownload.Count) update(s)..."
    $dl = $session.CreateUpdateDownloader(); $dl.Updates = $toDownload
    $dr = $dl.Download()
    Write-Output "Download result code: $($dr.ResultCode)"
  }
  $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
  foreach ($u in $result.Updates) { if ($u.IsDownloaded) { $toInstall.Add($u) | Out-Null } }
  if ($toInstall.Count -eq 0) { Write-Output 'Nothing downloaded; cannot install.'; Write-Output '@@JSON {"ok":false,"installed":0,"rebootRequired":false}'; exit 0 }
  Write-Output "Installing $($toInstall.Count) update(s)..."
  $inst = $session.CreateUpdateInstaller(); $inst.Updates = $toInstall
  $ir = $inst.Install()
  $ok = 0
  for ($i = 0; $i -lt $toInstall.Count; $i++) {
    $code = $ir.GetUpdateResult($i).ResultCode
    if ($code -eq 2) { $ok++ }
    Write-Output ("  " + $toInstall.Item($i).Title + " -> " + $(switch ($code) { 2 { 'Succeeded' } 3 { 'Succeeded with errors' } 4 { 'Failed' } 5 { 'Aborted' } default { "code $code" } }))
  }
  Write-Output ("Overall result: " + $ir.ResultCode + "  Reboot required: " + $ir.RebootRequired)
  Write-Output ('@@JSON ' + ([pscustomobject]@{ ok = ($ir.ResultCode -eq 2); installed = $ok; rebootRequired = [bool]$ir.RebootRequired } | ConvertTo-Json -Compress))
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
  Write-Output ('@@JSON ' + ([pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
}
