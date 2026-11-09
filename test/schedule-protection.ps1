$ErrorActionPreference = 'Stop'
# Load ONLY the validation function AST. Never run the scheduler's install block.
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\ps\schedule.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
$fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-ProtectedExecutable' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$script:fakeSid = 'S-1-5-18'; $script:ownerSid = 'S-1-5-32-544'; $script:reparse = $false; $script:unsafeChild = $false
$script:fakeRights = [Security.AccessControl.FileSystemRights]::Modify
function Get-Item { param($LiteralPath, [switch]$Force)
  [pscustomobject]@{ PSIsContainer = $false; Attributes = $(if ($script:reparse) { [IO.FileAttributes]::ReparsePoint } else { [IO.FileAttributes]::Normal }) }
}
function Get-Acl { param($LiteralPath)
  $obj = [pscustomobject]@{ FixturePath = $LiteralPath }
  $obj | Add-Member ScriptMethod GetOwner { param($type) [pscustomobject]@{ Value = $script:ownerSid } }
  $obj | Add-Member ScriptMethod GetAccessRules { param($explicit, $inherited, $type)
    [pscustomobject]@{ AccessControlType = 'Allow'; PropagationFlags = [Security.AccessControl.PropagationFlags]::None;
      FileSystemRights = $script:fakeRights; IdentityReference = [pscustomobject]@{ Value = $(if ($script:unsafeChild -and $this.FixturePath -like '*main.js') { 'S-1-5-32-545' } else { $script:fakeSid }) } }
  }
  return $obj
}
function Get-ChildItem { param($LiteralPath, [switch]$Force)
  [pscustomobject]@{ FullName = (Join-Path $LiteralPath 'main.js'); PSIsContainer = $false }
}
$fixture = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'NodeMend\NodeMend.exe'
if ((Assert-ProtectedExecutable $fixture) -ne $fixture) { throw 'Protected fixture rejected' }
$script:fakeSid = 'S-1-5-32-545'
try { Assert-ProtectedExecutable $fixture; throw 'BUG: writable fixture allowed' } catch { if ($_.Exception.Message -notlike '*Unsafe permissions*') { throw } }
foreach ($bits in @(268435456, 1073741824, -1610612736)) {
  $script:fakeRights = $bits
  try { Assert-ProtectedExecutable $fixture; throw 'BUG: generic rights allowed' } catch { if ($_.Exception.Message -notlike '*Unsafe permissions*') { throw } }
}
$script:fakeRights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
if ((Assert-ProtectedExecutable $fixture) -ne $fixture) { throw 'Read-only ACL rejected' }
$script:fakeRights = [Security.AccessControl.FileSystemRights]::Modify
$script:fakeSid = 'S-1-5-18'; $script:reparse = $true
try { Assert-ProtectedExecutable $fixture; throw 'BUG: reparse fixture allowed' } catch { if ($_.Exception.Message -notlike '*Reparse point*') { throw } }
$script:reparse = $false; $script:unsafeChild = $true
try { Assert-ProtectedExecutable $fixture; throw 'BUG: writable sibling code allowed' } catch { if ($_.Exception.Message -notlike '*Unsafe permissions*main.js*') { throw } }
$script:unsafeChild = $false; $script:ownerSid = 'S-1-5-21-123-123-123-1001'
try { Assert-ProtectedExecutable $fixture; throw 'BUG: untrusted owner allowed' } catch { if ($_.Exception.Message -notlike '*Unsafe owner*') { throw } }
Write-Output 'PASS protected path, unsafe ACL/owner/sibling code and junction fixtures (no scheduled-task calls)'
