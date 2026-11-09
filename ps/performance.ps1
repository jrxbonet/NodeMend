# Pause/resume a user-selected optional background app. No elevation, killing, or settings changes.
# The native helper validates the SAME process handle used by the action (PID reuse defense).
param(
  [ValidateSet('List','Pause','Resume')][string]$Action = 'List',
  [int]$TargetProcessId = 0,
  [string]$ExpectedStartTime = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class TidyBackgroundProcess {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(int pid, out uint session);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr process);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr process);
  static bool Allowed(string name) {
    return name.Equals("Spotify.exe", StringComparison.OrdinalIgnoreCase) ||
      name.Equals("Discord.exe", StringComparison.OrdinalIgnoreCase) ||
      name.Equals("steam.exe", StringComparison.OrdinalIgnoreCase);
  }
  public sealed class Record {
    public int pid; public int ppid; public string name; public string location;
    public string startTime; public string owner; public int session;
  }
  public static Record Inspect(int pid, string expected, string action) {
    if (pid <= 1 || pid == Process.GetCurrentProcess().Id) throw new Exception("PROTECTED_PROCESS");
    // PROCESS_QUERY_LIMITED_INFORMATION plus PROCESS_SUSPEND_RESUME only for explicit actions.
    uint access = 0x1000; if (action != "List") access |= 0x0800;
    IntPtr handle = OpenProcess(access, false, pid);
    if (handle == IntPtr.Zero) throw new Exception("PROCESS_ACCESS_DENIED");
    IntPtr token = IntPtr.Zero;
    try {
      long creation, exit, kernel, user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new Exception("PROCESS_TIMES_UNAVAILABLE");
      if (action != "List" && creation.ToString() != expected) throw new Exception("PROCESS_CHANGED");
      var buffer = new StringBuilder(32768); int size = buffer.Capacity;
      if (!QueryFullProcessImageName(handle, 0, buffer, ref size)) throw new Exception("PROCESS_IMAGE_UNAVAILABLE");
      string location = buffer.ToString(); string name = Path.GetFileName(location);
      if (!Allowed(name)) throw new Exception("PROCESS_NOT_ELIGIBLE");
      uint session;
      if (!ProcessIdToSessionId(pid, out session) || session == 0 || session != Process.GetCurrentProcess().SessionId) throw new Exception("SESSION_MISMATCH");
      if (!OpenProcessToken(handle, 0x0008, out token)) throw new Exception("OWNER_UNAVAILABLE");
      string owner;
      using (var identity = new WindowsIdentity(token)) { owner = identity.User.Value; }
      using (var identity = WindowsIdentity.GetCurrent()) {
        if (owner != identity.User.Value) throw new Exception("OWNER_MISMATCH");
      }
      var result = new Record { pid=pid, name=name, location=location, startTime=creation.ToString(), owner=owner, session=(int)session };
      int status = 0;
      if (action == "Pause") status = NtSuspendProcess(handle);
      else if (action == "Resume") status = NtResumeProcess(handle);
      if (status != 0) throw new Exception("NATIVE_ACTION_FAILED: " + status.ToString());
      return result;
    } finally {
      if (token != IntPtr.Zero) CloseHandle(token);
      CloseHandle(handle);
    }
  }
}
'@
if ($Action -eq 'List') {
  $rows = @()
  # Include just PID ancestry for other processes; never export their command lines or owners.
  $parents = @{}
  foreach ($item in Get-CimInstance Win32_Process) {
    $parents[[int]$item.ProcessId] = [int]$item.ParentProcessId
    $rows += [pscustomobject]@{ pid=[int]$item.ProcessId; ppid=[int]$item.ParentProcessId; name=''; owner=''; startTime='' }
  }
  foreach ($item in Get-Process -Name Spotify,Discord,steam -ErrorAction SilentlyContinue) {
    try {
      $r = [TidyBackgroundProcess]::Inspect($item.Id, '', 'List')
      $rows += [pscustomobject]@{ pid=$r.pid; ppid=$parents[$r.pid]; name=$r.name; location=$r.location; startTime=$r.startTime; owner=$r.owner; session=$r.session }
    } catch { } # Processes owned by others, inaccessible, or exiting are excluded.
  }
  ConvertTo-Json -InputObject @($rows) -Compress
} else {
  if ($TargetProcessId -le 1 -or $ExpectedStartTime -notmatch '^\d+$') { throw 'INVALID_PROCESS_IDENTITY' }
  $r = [TidyBackgroundProcess]::Inspect($TargetProcessId, $ExpectedStartTime, $Action)
  [pscustomobject]@{ ok=$true; pid=$r.pid; action=$Action; startTime=$r.startTime } | ConvertTo-Json -Compress
}
