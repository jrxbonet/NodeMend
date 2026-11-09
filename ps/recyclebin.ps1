# Recycle Bin size/count; with -Empty it is emptied first and the amount removed is reported.
param([switch]$Empty)
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$bin = $shell.NameSpace(0xA)
$size = 0; $count = 0
foreach ($item in $bin.Items()) { $size += $item.Size; $count++ }
if ($Empty) { Clear-RecycleBin -Force -ErrorAction SilentlyContinue }
[pscustomobject]@{ size = [int64]$size; count = $count; emptied = [bool]$Empty } | ConvertTo-Json -Compress
