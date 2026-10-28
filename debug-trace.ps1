$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$ErrorActionPreference = 'Continue'
$log = Join-Path $dir "runtime-error.log"
"Starting..." | Set-Content $log -Encoding UTF8

$psFile = Join-Path $dir "AgentPet.ps1"
if (-not (Test-Path $psFile)) { $psFile = Join-Path $dir "NiangPet.ps1" }

$global:Error.Clear()
try {
    & $psFile
} catch {
    "CATCH: $($_.Exception.ToString())" | Add-Content $log -Encoding UTF8
}

if ($global:Error.Count -gt 0) {
    "ERRORS:" | Add-Content $log -Encoding UTF8
    $global:Error | ForEach-Object { $_.ToString() } | Add-Content $log -Encoding UTF8
}
"End." | Add-Content $log -Encoding UTF8
