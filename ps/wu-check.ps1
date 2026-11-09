# Query Windows Update for pending updates via the COM agent. Prints one JSON document.
$ErrorActionPreference = 'Stop'
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $result = $searcher.Search('IsInstalled=0 and IsHidden=0')
  $updates = @()
  foreach ($u in $result.Updates) {
    $updates += [pscustomobject]@{ title = $u.Title; sizeMB = [math]::Round($u.MaxDownloadSize / 1MB, 1)
      kb = (($u.KBArticleIDs | ForEach-Object { "KB$_" }) -join ', '); severity = "$($u.MsrcSeverity)"; downloaded = $u.IsDownloaded; rebootRequired = $u.RebootRequired }
  }
  $hist = $searcher.QueryHistory(0, 8) | ForEach-Object {
    [pscustomobject]@{ title = $_.Title; date = $_.Date.ToString('s'); result = switch ($_.ResultCode) { 2 { 'Succeeded' } 3 { 'Succeeded with errors' } 4 { 'Failed' } 5 { 'Aborted' } default { "Code $($_.ResultCode)" } } }
  }
  [pscustomobject]@{ ok = $true; count = $updates.Count; updates = $updates; history = @($hist) } | ConvertTo-Json -Depth 4 -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message; updates = @(); history = @() } | ConvertTo-Json -Compress
}
