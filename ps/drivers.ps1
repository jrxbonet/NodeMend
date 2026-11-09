# Vendor-agnostic driver check: asks the Microsoft Update driver channel for drivers matching
# the hardware that is actually installed, and lists devices reporting problems. Prints JSON.
$ErrorActionPreference = 'SilentlyContinue'
$MU = '7971f918-a847-4430-9279-4a52d1efe18d'   # Microsoft Update service (drivers for all vendors)

$result = [ordered]@{ ok = $true; drivers = @(); problemDevices = @(); installedCount = 0; oldest = @(); error = $null }
try {
  $sm = New-Object -ComObject Microsoft.Update.ServiceManager
  $sm.ClientApplicationID = 'NodeMend'
  $null = $sm.AddService2($MU, 7, '')          # register Microsoft Update if it is not already
  $session = New-Object -ComObject Microsoft.Update.Session
  $session.ClientApplicationID = 'NodeMend'
  $searcher = $session.CreateUpdateSearcher()
  $searcher.ServerSelection = 3                # ssOthers
  $searcher.ServiceID = $MU
  $searcher.Online = $true
  $sr = $searcher.Search("IsInstalled=0 and Type='Driver' and IsHidden=0")
  foreach ($u in $sr.Updates) {
    $d = $u | Select-Object -First 1
    $result.drivers += [pscustomobject]@{
      title = $u.Title; provider = "$($u.DriverProvider)"; manufacturer = "$($u.DriverManufacturer)"; model = "$($u.DriverModel)"
      class = "$($u.DriverClass)"; version = "$($u.DriverVerDate)"; hwid = "$($u.DriverHardwareID)"
      sizeMB = [math]::Round($u.MaxDownloadSize / 1MB, 1); rebootRequired = [bool]$u.RebootRequired; id = $u.Identity.UpdateID }
  }
} catch { $result.ok = $false; $result.error = $_.Exception.Message }

$result.problemDevices = @(Get-PnpDevice -PresentOnly | Where-Object { $_.Status -ne 'OK' -and $_.Status -ne 'Unknown' } | ForEach-Object {
  [pscustomobject]@{ name = $_.FriendlyName; class = $_.Class; status = "$($_.Status)"; problem = "$($_.Problem)"; id = $_.InstanceId } })

$drv = @(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DriverDate -and $_.DeviceName -and $_.DriverProviderName -ne 'Microsoft' })
$result.installedCount = $drv.Count
$result.oldest = @($drv | Sort-Object DriverDate | Select-Object -First 8 | ForEach-Object {
  [pscustomobject]@{ device = $_.DeviceName; provider = $_.DriverProviderName; version = $_.DriverVersion; date = $_.DriverDate.ToString('yyyy-MM-dd'); class = $_.DeviceClass } })

[pscustomobject]$result | ConvertTo-Json -Depth 4 -Compress
