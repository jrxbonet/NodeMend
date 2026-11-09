# Run the built-in Disk Cleanup silently with a fixed set of safe handlers (profile 77).
# "Update Cleanup" is what removes superseded Windows Update components - the big win.
# cleanmgr /sagerun walks EVERY drive; on machines with large external disks the
# "calculating" phase for those drives can run for hours, so a watcher cancels the run
# as soon as the dialog moves past the target drive (C: is always processed first).
param([string]$Drive = 'C:')
$ErrorActionPreference = 'SilentlyContinue'
$handlers = @('Temporary Files', 'Temporary Setup Files', 'Update Cleanup', 'Windows Error Reporting Files',
  'Delivery Optimization Files', 'Thumbnail Cache', 'DirectX Shader Cache', 'Downloaded Program Files',
  'Internet Cache Files', 'Old ChkDsk Files', 'Setup Log Files', 'Windows Defender', 'Device Driver Packages',
  'Windows Upgrade Log Files', 'Previous Installations')
$base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches'
$enabled = @()
foreach ($k in Get-ChildItem $base) {
  $flag = if ($handlers -contains $k.PSChildName) { 2 } else { 0 }
  Set-ItemProperty -Path $k.PSPath -Name 'StateFlags0077' -Value $flag -Type DWord
  if ($flag -eq 2) { $enabled += $k.PSChildName }
}
Write-Output ("Disk Cleanup handlers enabled: " + ($enabled -join ', '))

Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class CmWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  // Returns the dialog texts for a process; clicks Cancel when cancel==true.
  public static List<string> Texts(uint pid, bool cancel) {
    var texts = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p != pid) return true;
      EnumChildWindows(h, (ch, l2) => { var t = new StringBuilder(512); GetWindowText(ch, t, 512);
        string s = t.ToString(); if (s.Length > 0) texts.Add(s);
        if (cancel && s == "Cancel") SendMessage(ch, 0x00F5 /*BM_CLICK*/, IntPtr.Zero, IntPtr.Zero);
        return true; }, IntPtr.Zero);
      return true; }, IntPtr.Zero);
    return texts; }
}
"@

$free0 = (Get-PSDrive $Drive.TrimEnd(':')).Free
Write-Output "Running cleanmgr /sagerun:77 on $Drive ... (Windows Update Cleanup can take 5-15 minutes)"
$p = Start-Process -FilePath "$env:SystemRoot\System32\cleanmgr.exe" -ArgumentList "/d $Drive /sagerun:77" -PassThru -WindowStyle Hidden
$lastStatus = ''; $cancelled = $false
while (-not $p.HasExited) {
  Start-Sleep -Seconds 3
  $texts = [CmWin]::Texts([uint32]$p.Id, $false)
  $driveLine = $texts | Where-Object { $_ -match '\(([A-Z]):\)' } | Select-Object -First 1
  if ($driveLine -and $driveLine -notmatch [regex]::Escape("($Drive)")) {
    Write-Output "Disk Cleanup moved on to another drive ($driveLine) - stopping, $Drive is done."
    [CmWin]::Texts([uint32]$p.Id, $true) | Out-Null
    Start-Sleep -Seconds 3
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
    $cancelled = $true
    break
  }
  $status = ($texts | Where-Object { $_ -notmatch '^(Cancel|Cleaning:|Scanning:)$' -and $_ -notmatch 'utility is cleaning|calculating how much' }) -join ' | '
  if ($status -and $status -ne $lastStatus) { Write-Output "  $status"; $lastStatus = $status }
}
$free1 = (Get-PSDrive $Drive.TrimEnd(':')).Free
Write-Output ("Disk Cleanup finished. Free space change on {0}: {1:N0} MB" -f $Drive, (($free1 - $free0) / 1MB))
Write-Output ('@@JSON ' + ([pscustomobject]@{ ok = $true; freed = [int64]($free1 - $free0); handlers = $enabled; stoppedAtOtherDrive = $cancelled } | ConvertTo-Json -Compress))
