# Defender actions: -Action Update | QuickScan. Streams lines; final line is @@JSON.
param([ValidateSet('Update', 'QuickScan')][string]$Action = 'Update')
$ErrorActionPreference = 'Stop'
try {
  $before = Get-MpComputerStatus
  if ($Action -eq 'Update') {
    Write-Output "Current signature version: $($before.AntivirusSignatureVersion) (age $($before.AntivirusSignatureAge) days)"
    Write-Output 'Contacting Microsoft Update for security intelligence...'
    Update-MpSignature
    $after = Get-MpComputerStatus
    Write-Output "Signature version now: $($after.AntivirusSignatureVersion)"
    Write-Output ('@@JSON ' + ([pscustomobject]@{ ok = $true; before = $before.AntivirusSignatureVersion; after = $after.AntivirusSignatureVersion } | ConvertTo-Json -Compress))
  } else {
    Write-Output 'Starting Microsoft Defender quick scan (this can take several minutes)...'
    Start-MpScan -ScanType QuickScan
    $after = Get-MpComputerStatus
    $threats = @(Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -gt (Get-Date).AddHours(-1) })
    Write-Output "Quick scan finished at $($after.QuickScanEndTime). Threats found in last hour: $($threats.Count)"
    Write-Output ('@@JSON ' + ([pscustomobject]@{ ok = $true; threats = $threats.Count; finished = "$($after.QuickScanEndTime)" } | ConvertTo-Json -Compress))
  }
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
  Write-Output ('@@JSON ' + ([pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
}
